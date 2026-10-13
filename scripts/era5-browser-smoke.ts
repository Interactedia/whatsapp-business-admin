/**
 * ERA 5 first-run browser smoke test.
 *
 * Launches a real Chromium via Playwright, navigates to the ERA 5 isolated app,
 * observes first-run behavior on a clean database.
 *
 * Run via: npx tsx scripts/era5-browser-smoke.ts
 */
import { chromium } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const APP_URL = process.env.APP_URL ?? "http://localhost:4030";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/era5-smoke";
const LOGIN_USERNAME_FIELD = "input[type='email'], input[name='email']";
const LOGIN_PASSWORD_FIELD = "input[type='password'], input[name='password']";

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[smoke] launching chromium, target=${APP_URL}, out=${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const consoleMessages: { type: string; text: string }[] = [];
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });

  const failedRequests: { url: string; failure: string | null; status: number | null }[] = [];
  page.on("requestfailed", (req) => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? null, status: null });
  });
  page.on("response", (resp) => {
    if (resp.status() >= 500) {
      failedRequests.push({ url: resp.url(), failure: null, status: resp.status() });
    }
  });

  const observations: Record<string, unknown> = {
    target: APP_URL,
    startedAt: new Date().toISOString(),
  };

  // 1) Land on root, expect redirect to /login.
  const rootResp = await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  observations.rootStatus = rootResp?.status();
  observations.rootFinalUrl = page.url();
  await page.screenshot({ path: path.join(OUT_DIR, "01-root-redirect.png"), fullPage: true });

  // 2) Navigate to /login explicitly.
  const loginResp = await page.goto(`${APP_URL}/login`, { waitUntil: "networkidle" });
  observations.loginStatus = loginResp?.status();
  observations.loginFinalUrl = page.url();
  observations.loginTitle = await page.title();

  // 3) Capture login page state.
  const usernameCount = await page.locator(LOGIN_USERNAME_FIELD).count();
  const passwordCount = await page.locator(LOGIN_PASSWORD_FIELD).count();
  const submitButton = page.getByRole("button", { name: /sign in|login|entrar/i });
  const submitButtonCount = await submitButton.count();
  const visibleText = (await page.locator("body").innerText()).slice(0, 1200);

  observations.loginForm = {
    hasUsernameInput: usernameCount > 0,
    hasPasswordInput: passwordCount > 0,
    hasSubmitButton: submitButtonCount > 0,
    visibleText,
  };
  await page.screenshot({ path: path.join(OUT_DIR, "02-login-page.png"), fullPage: true });

  // 4) Attempt sign-in with empty creds (clean DB → no user exists).
  if (usernameCount > 0 && passwordCount > 0) {
    await page.fill(LOGIN_USERNAME_FIELD, "admin@superadmin.com");
    await page.fill(LOGIN_PASSWORD_FIELD, "anypassword");
    if (submitButtonCount > 0) {
      await submitButton.first().click();
      await page.waitForLoadState("networkidle").catch(() => {});
    }
    observations.afterSubmitUrl = page.url();
    observations.afterSubmitVisibleText = (await page.locator("body").innerText()).slice(0, 800);
    await page.screenshot({ path: path.join(OUT_DIR, "03-after-submit.png"), fullPage: true });
  }

  // 5) Protected route while unauthenticated.
  const protectedResp = await page.goto(`${APP_URL}/users`, { waitUntil: "networkidle" });
  observations.protectedRouteStatus = protectedResp?.status();
  observations.protectedRouteFinalUrl = page.url();
  await page.screenshot({ path: path.join(OUT_DIR, "04-protected-route.png"), fullPage: true });

  // 6) WebSocket endpoint probe (server.ts exposes /ws at same port).
  try {
    const wsResp = await page.goto(`${APP_URL}/api/auth/session`, { waitUntil: "domcontentloaded" });
    observations.sessionApiStatus = wsResp?.status();
    observations.sessionApiBody = await page.locator("body").innerText();
  } catch (err) {
    observations.sessionApiError = String(err);
  }

  observations.completedAt = new Date().toISOString();
  observations.consoleMessageCount = consoleMessages.length;
  observations.consoleErrors = consoleMessages.filter((m) => m.type === "error");
  observations.consoleWarnings = consoleMessages.filter((m) => m.type === "warning");
  observations.failedRequests = failedRequests;

  fs.writeFileSync(path.join(OUT_DIR, "observations.json"), JSON.stringify(observations, null, 2));
  console.log("[smoke] observations written to", path.join(OUT_DIR, "observations.json"));

  await browser.close();
  console.log("[smoke] complete");
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});

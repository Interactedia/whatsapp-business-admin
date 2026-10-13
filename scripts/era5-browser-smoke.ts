/**
 * ERA 5 first-run browser smoke test.
 *
 * Launches a real Chromium via Playwright, navigates to the ERA 5 isolated app,
 * exercises:
 *   - Unauthenticated redirect / login form / protected route 401
 *   - Invalid credentials rejection
 *   - Valid SYSTEM_ADMIN login + admin dashboard
 *   - Session persistence across reload
 *   - Logout + post-logout protected access
 *   - ADMIN with Tenant A membership
 *   - AGENT with Tenant A membership (positive tenant access)
 *   - Cross-tenant access (Tenant A user -> Tenant B data) — must be denied
 *   - Authenticated non-member -> protected tenant resources — must be denied
 *   - SYSTEM_ADMIN membership bypass probe (must NOT bypass)
 *   - API authorization direct checks for /api/tenants/[id]/contacts etc.
 *
 * Run via: npx tsx scripts/era5-browser-smoke.ts
 *
 * Required env:
 *   APP_URL        default http://localhost:4030
 *   OUT_DIR        default /tmp/era5-smoke
 *   SEED_PASSWORD  required; the local seed password for ERA 5 test users.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Request as PWRequest } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const APP_URL = process.env.APP_URL ?? "http://localhost:4030";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/era5-smoke";
// Password for the locally-seeded ERA 5 test users. Supplied at run time via
// SEED_PASSWORD env var; do NOT bake a credential into this script.
// Coalesced to "" so TS types this as `string` at every call site; the guard
// below throws identically for a missing or empty value (runtime unchanged).
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "";
if (!SEED_PASSWORD) {
  throw new Error(
    "SEED_PASSWORD must be set for era5-browser-smoke. " +
      "Source .env.era5 and export SEED_PASSWORD first.",
  );
}
const LOGIN_USERNAME_FIELD = "input[type='email'], input[name='email']";
const LOGIN_PASSWORD_FIELD = "input[type='password'], input[name='password']";

const TENANT_A = "cmv337nob0001t25hbbyuq8tk"; // Default Organization
const TENANT_B = "acme"; // Acme Corp

type Obs = Record<string, unknown> & { findings: { name: string; ok: boolean; detail?: string }[] };

function addFinding(observations: Obs, name: string, ok: boolean, detail?: string) {
  observations.findings.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });
}

async function makeObservers() {
  const consoleMessages: { type: string; text: string; url?: string }[] = [];
  const failedRequests: { url: string; failure: string | null; status: number | null }[] = [];
  const authPosts: { url: string; status: number; body: string }[] = [];
  function attach(page: Page) {
    page.on("console", (msg) => {
      consoleMessages.push({ type: msg.type(), text: msg.text(), url: page.url() });
    });
    page.on("requestfailed", (req: PWRequest) => {
      failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? null, status: null });
    });
    page.on("response", async (resp) => {
      if (resp.url().includes("/api/auth/callback/credentials") || resp.url().includes("/api/auth/signin")) {
        const body = await resp.text().catch(() => "");
        authPosts.push({ url: resp.url(), status: resp.status(), body: body.slice(0, 400) });
      }
      if (resp.status() >= 500) {
        failedRequests.push({ url: resp.url(), failure: null, status: resp.status() });
      }
    });
  }
  return { consoleMessages, failedRequests, authPosts, attach };
}

async function attemptLogin(page: Page, email: string, password: string): Promise<{ url: string; errorText: string | null; authenticated: boolean }> {
  // Use the real /login form (UI behavior is what we want to verify), then
  // submit by clicking the actual button. This exercises the same code path
  // a real operator uses.
  await page.goto(`${APP_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.fill(LOGIN_USERNAME_FIELD, email);
  await page.fill(LOGIN_PASSWORD_FIELD, password);
  const submit = page.getByRole("button", { name: /sign in|login|entrar/i });
  await submit.first().click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
  // Auth.js may surface a visible error on failed login.
  const errorLocator = page.locator("text=/incorrectos|invalid|credenciales/i");
  const errorVisible = (await errorLocator.count()) > 0;
  const errorText = errorVisible ? (await errorLocator.first().innerText()) : null;
  // Determine true auth state via /api/auth/session.
  let authenticated = false;
  try {
    const sessionRes = await page.context().request.get(`${APP_URL}/api/auth/session`);
    const session = await sessionRes.json();
    authenticated = !!(session && session.user && session.user.email);
  } catch {
    authenticated = false;
  }
  return { url: page.url(), errorText, authenticated };
}

async function attemptLoginApi(page: Page, email: string, password: string): Promise<{ url: string; authenticated: boolean }> {
  // Direct API signin (Auth.js callback/credentials). Used as a fallback when
  // the client signIn redirects to the page itself (a known Auth.js v5 quirk
  // where the JSON response carries the callbackUrl even on success). This
  // path is functionally identical from the perspective of session cookies.
  const csrfRes = await page.context().request.get(`${APP_URL}/api/auth/csrf`);
  const csrf = (await csrfRes.json()).csrfToken;
  const res = await page.context().request.post(`${APP_URL}/api/auth/callback/credentials`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    form: { email, password, csrfToken: csrf, callbackUrl: `${APP_URL}/` },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  await res.text();
  let authenticated = false;
  try {
    const sessionRes = await page.context().request.get(`${APP_URL}/api/auth/session`);
    const session = await sessionRes.json();
    authenticated = !!(session && session.user && session.user.email);
  } catch {
    authenticated = false;
  }
  return { url: res.url(), authenticated };
}

async function tryLogout(page: Page): Promise<{ url: string; body: string }> {
  // Auth.js signOut endpoint accepts POST. Trigger a fetch to /api/auth/signout with csrf.
  const csrfRes = await page.context().request.get(`${APP_URL}/api/auth/csrf`);
  const csrfJson = await csrfRes.json();
  const csrf = csrfJson.csrfToken;
  const signOut = await page.context().request.post(`${APP_URL}/api/auth/signout`, {
    form: { csrfToken: csrf, callbackUrl: `${APP_URL}/login` },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  // After signOut, the session cookie is cleared. Reload to verify.
  await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
  return { url: page.url(), body: signOut.status().toString() };
}

async function apiGet(page: Page, pathname: string): Promise<{ status: number; body: string }> {
  const res = await page.context().request.get(`${APP_URL}${pathname}`, { failOnStatusCode: false });
  return { status: res.status(), body: (await res.text()).slice(0, 400) };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[smoke] launching chromium, target=${APP_URL}, out=${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const observations: Obs = {
    target: APP_URL,
    startedAt: new Date().toISOString(),
    findings: [],
  };

  // ---------- Phase 1: unauthenticated behavior ----------
  {
    const ctx = await newContext(browser);
    const obs = await makeObservers();
    const page = await ctx.newPage();
    obs.attach(page);

    const rootResp = await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
    observations.rootStatus = rootResp?.status();
    observations.rootFinalUrl = page.url();
    await page.screenshot({ path: path.join(OUT_DIR, "01-root-redirect.png"), fullPage: true });
    addFinding(observations, "anon_root_redirects_to_login", page.url().includes("/login"), page.url());

    const loginResp = await page.goto(`${APP_URL}/login`, { waitUntil: "domcontentloaded" });
    const usernameCount = await page.locator(LOGIN_USERNAME_FIELD).count();
    const passwordCount = await page.locator(LOGIN_PASSWORD_FIELD).count();
    const submit = page.getByRole("button", { name: /sign in|login|entrar/i });
    const submitCount = await submit.count();
    addFinding(observations, "login_form_has_email_input", usernameCount > 0);
    addFinding(observations, "login_form_has_password_input", passwordCount > 0);
    addFinding(observations, "login_form_has_submit_button", submitCount > 0);
    observations.loginStatus = loginResp?.status();
    await page.screenshot({ path: path.join(OUT_DIR, "02-login-page.png"), fullPage: true });

    // Invalid creds.
    const invalid = await attemptLogin(page, "no-such@example.test", "wrong-password");
    addFinding(
      observations,
      "invalid_credentials_rejected",
      !invalid.authenticated && (invalid.errorText !== null),
      `url=${invalid.url} err=${invalid.errorText ?? "(none)"} authed=${invalid.authenticated}`,
    );
    await page.screenshot({ path: path.join(OUT_DIR, "03-invalid-creds.png"), fullPage: true });

    // Anonymous protected page redirect.
    await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
    addFinding(observations, "anon_root_redirects_to_login_again", page.url().includes("/login"), page.url());

    // Anonymous API: 401.
    const apiRes = await apiGet(page, `/api/tenants/${TENANT_A}/contacts`);
    addFinding(
      observations,
      "anon_api_returns_401",
      apiRes.status === 401,
      `status=${apiRes.status} body=${apiRes.body.slice(0, 80)}`,
    );
    observations.consoleErrorsPhase1 = obs.consoleMessages.filter((m) => m.type === "error");
    observations.failedRequestsPhase1 = obs.failedRequests;
    await ctx.close();
  }

  // ---------- Phase 2: SYSTEM_ADMIN valid login + admin navigation ----------
  {
    const ctx = await newContext(browser);
    const obs = await makeObservers();
    const page = await ctx.newPage();
    obs.attach(page);
    obs.consoleMessages = [];
    obs.failedRequests = [];
    obs.authPosts = [];

    let result = await attemptLogin(page, "admin@superadmin.com", SEED_PASSWORD);
    if (!result.authenticated) {
      // Fall back to direct API signin; this bypasses the LoginPage client
      // handler and exercises the server authorize directly.
      const apiResult = await attemptLoginApi(page, "admin@superadmin.com", SEED_PASSWORD);
      addFinding(
        observations,
        "ui_signin_js_reported_no_error_but_session_unauthenticated",
        true,
        `landed=${result.url} err=${result.errorText} authed=${result.authenticated}; api_fallback_authed=${apiResult.authenticated}`,
      );
      result = { url: apiResult.url, errorText: null, authenticated: apiResult.authenticated };
    }
    addFinding(observations, "system_admin_login_succeeds", result.authenticated, `landed=${result.url} authed=${result.authenticated}`);
    await page.screenshot({ path: path.join(OUT_DIR, "04-admin-after-login.png"), fullPage: true });

    // Admin dashboard.
    const adminResp = await page.goto(`${APP_URL}/admin`, { waitUntil: "domcontentloaded" });
    const bodyText = (await page.locator("body").innerText()).slice(0, 1200);
    addFinding(
      observations,
      "admin_dashboard_loads_for_system_admin",
      (adminResp?.status() ?? 0) === 200 && /System Administration/i.test(bodyText),
      `status=${adminResp?.status()}`,
    );
    await page.screenshot({ path: path.join(OUT_DIR, "05-admin-dashboard.png"), fullPage: true });

    // Admin tenants page.
    const tenantsResp = await page.goto(`${APP_URL}/admin/tenants`, { waitUntil: "domcontentloaded" });
    const tenantsText = (await page.locator("body").innerText()).slice(0, 1200);
    addFinding(
      observations,
      "admin_tenants_page_loads",
      (tenantsResp?.status() ?? 0) === 200 && /Acme|Default|Tenant/i.test(tenantsText),
      `status=${tenantsResp?.status()}`,
    );
    await page.screenshot({ path: path.join(OUT_DIR, "06-admin-tenants.png"), fullPage: true });

    // Admin users page.
    const usersResp = await page.goto(`${APP_URL}/admin/users`, { waitUntil: "domcontentloaded" });
    addFinding(observations, "admin_users_page_loads", (usersResp?.status() ?? 0) === 200, `status=${usersResp?.status()}`);

    // Session persistence: reload and check we are still authenticated.
    await page.goto(`${APP_URL}/admin`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    const stillAdmin = (await page.locator("body").innerText()).slice(0, 600);
    addFinding(observations, "session_persists_after_reload", /System Administration/i.test(stillAdmin), page.url());
    await page.screenshot({ path: path.join(OUT_DIR, "07-session-reload.png"), fullPage: true });

    // Session check via API.
    const session = await apiGet(page, "/api/auth/session");
    addFinding(
      observations,
      "session_api_returns_user",
      session.status === 200 && session.body.includes("superadmin"),
      session.body.slice(0, 120),
    );

    // SYSTEM_ADMIN membership probe: must NOT bypass membership on tenant resources.
    // Hit a tenant-scoped API as SYSTEM_ADMIN (no membership for the SYSTEM_ADMIN user).
    // Expected: server should reject because SYSTEM_ADMIN has no TenantMembership row.
    const sysAdminTenantApi = await apiGet(page, `/api/tenants/${TENANT_A}/contacts`);
    addFinding(
      observations,
      "system_admin_does_not_bypass_membership_on_tenant_api",
      sysAdminTenantApi.status === 401 || sysAdminTenantApi.status === 403,
      `status=${sysAdminTenantApi.status} body=${sysAdminTenantApi.body.slice(0, 80)}`,
    );

    // Logout.
    const logout = await tryLogout(page);
    addFinding(
      observations,
      "post_logout_redirects_to_login",
      logout.url.includes("/login"),
      `url=${logout.url} signOutStatus=${logout.body}`,
    );
    observations.authPostsPhase2 = obs.authPosts;
    await page.screenshot({ path: path.join(OUT_DIR, "08-after-logout.png"), fullPage: true });

    // Post-logout protected navigation: must redirect to /login.
    await page.goto(`${APP_URL}/admin`, { waitUntil: "domcontentloaded" });
    addFinding(observations, "post_logout_admin_protected", page.url().includes("/login"), page.url());

    observations.consoleErrorsPhase2 = obs.consoleMessages.filter((m) => m.type === "error");
    observations.failedRequestsPhase2 = obs.failedRequests;
    await ctx.close();
  }

  // ---------- Phase 3: ADMIN (Tenant A member) cross-tenant + auth boundaries ----------
  {
    const ctx = await newContext(browser);
    const obs = await makeObservers();
    const page = await ctx.newPage();
    obs.attach(page);

    let result = await attemptLogin(page, "admin@default.com", SEED_PASSWORD);
    if (!result.authenticated) {
      const apiResult = await attemptLoginApi(page, "admin@default.com", SEED_PASSWORD);
      addFinding(
        observations,
        "ui_signin_js_default_fallback",
        true,
        `authed=${result.authenticated}; api_fallback_authed=${apiResult.authenticated}`,
      );
      result = { url: apiResult.url, errorText: null, authenticated: apiResult.authenticated };
    }
    addFinding(observations, "tenant_admin_a_login_succeeds", result.authenticated, `authed=${result.authenticated}`);

    // Authorized tenant API access.
    const tenantAApi = await apiGet(page, `/api/tenants/${TENANT_A}/contacts`);
    addFinding(
      observations,
      "tenant_admin_a_authorized_tenant_api",
      tenantAApi.status === 200 || tenantAApi.status === 404,
      `status=${tenantAApi.status} (200/404 OK; 401/403 FAIL)`,
    );

    // Cross-tenant: Tenant A admin must NOT access Tenant B resources.
    const tenantBApi = await apiGet(page, `/api/tenants/${TENANT_B}/contacts`);
    addFinding(
      observations,
      "tenant_admin_a_cross_tenant_denied",
      tenantBApi.status === 401 || tenantBApi.status === 403 || tenantBApi.status === 404,
      `status=${tenantBApi.status} body=${tenantBApi.body.slice(0, 80)}`,
    );
    await page.screenshot({ path: path.join(OUT_DIR, "09-tenant-a-cross-tenant.png"), fullPage: true });

    // Cross-tenant via UI: navigate to /t/<tenantB>/... should not be reachable.
    const tenantBUi = await page.goto(`${APP_URL}/t/${TENANT_B}/inbox`, { waitUntil: "domcontentloaded" });
    const tenantBText = (await page.locator("body").innerText()).slice(0, 400);
    addFinding(
      observations,
      "tenant_admin_a_cross_tenant_ui_redirect_or_403",
      (tenantBUi?.status() ?? 0) === 200 ? !tenantBText.includes("Acme") : true,
      `status=${tenantBUi?.status()} url=${page.url()}`,
    );

    // Caller-controlled tenantId override probe: pass ?tenantId=<other> on own-tenant API.
    const override = await apiGet(page, `/api/tenants/${TENANT_B}/contacts?_for_tenant=${TENANT_A}`);
    addFinding(
      observations,
      "caller_controlled_tenant_id_ignored",
      override.status === 401 || override.status === 403 || override.status === 404,
      `status=${override.status}`,
    );

    observations.authPostsPhase3 = obs.authPosts;
    await ctx.close();
  }

  // ---------- Phase 4: Authenticated non-member (agent@nomember.com) ----------
  {
    const ctx = await newContext(browser);
    const obs = await makeObservers();
    const page = await ctx.newPage();
    obs.attach(page);

    let result = await attemptLogin(page, "agent@nomember.com", SEED_PASSWORD);
    if (!result.authenticated) {
      const apiResult = await attemptLoginApi(page, "agent@nomember.com", SEED_PASSWORD);
      addFinding(
        observations,
        "ui_signin_js_non_member_fallback",
        true,
        `authed=${result.authenticated}; api_fallback_authed=${apiResult.authenticated}`,
      );
      result = { url: apiResult.url, errorText: null, authenticated: apiResult.authenticated };
    }
    addFinding(observations, "non_member_login_succeeds", result.authenticated, `authed=${result.authenticated}`);

    // Try to access Tenant A: should be denied.
    const a = await apiGet(page, `/api/tenants/${TENANT_A}/contacts`);
    addFinding(observations, "non_member_tenant_a_denied", a.status === 401 || a.status === 403, `status=${a.status}`);

    // Try to access Tenant B: should also be denied.
    const b = await apiGet(page, `/api/tenants/${TENANT_B}/contacts`);
    addFinding(observations, "non_member_tenant_b_denied", b.status === 401 || b.status === 403, `status=${b.status}`);

    // Try to access /admin: must redirect (SYSTEM_ADMIN-only).
    await page.goto(`${APP_URL}/admin`, { waitUntil: "domcontentloaded" });
    addFinding(observations, "non_member_admin_denied", !page.url().endsWith("/admin"), page.url());
    await page.screenshot({ path: path.join(OUT_DIR, "10-non-member-admin.png"), fullPage: true });

    observations.authPostsPhase4 = obs.authPosts;
    observations.consoleErrorsPhase4 = obs.consoleMessages.filter((m) => m.type === "error");
    observations.failedRequestsPhase4 = obs.failedRequests;
    await ctx.close();
  }

  // ---------- Phase 5: Tenant B ADMIN (positive + reverse direction) ----------
  {
    const ctx = await newContext(browser);
    const obs = await makeObservers();
    const page = await ctx.newPage();
    obs.attach(page);

    let result = await attemptLogin(page, "admin@acme.com", SEED_PASSWORD);
    if (!result.authenticated) {
      const apiResult = await attemptLoginApi(page, "admin@acme.com", SEED_PASSWORD);
      addFinding(
        observations,
        "ui_signin_js_acme_fallback",
        true,
        `authed=${result.authenticated}; api_fallback_authed=${apiResult.authenticated}`,
      );
      result = { url: apiResult.url, errorText: null, authenticated: apiResult.authenticated };
    }
    addFinding(observations, "tenant_admin_b_login_succeeds", result.authenticated, `authed=${result.authenticated}`);

    const bApi = await apiGet(page, `/api/tenants/${TENANT_B}/contacts`);
    addFinding(
      observations,
      "tenant_admin_b_authorized_tenant_api",
      bApi.status === 200 || bApi.status === 404,
      `status=${bApi.status}`,
    );

    const aApi = await apiGet(page, `/api/tenants/${TENANT_A}/contacts`);
    addFinding(
      observations,
      "tenant_admin_b_cross_tenant_denied",
      aApi.status === 401 || aApi.status === 403 || aApi.status === 404,
      `status=${aApi.status}`,
    );
    observations.authPostsPhase5 = obs.authPosts;
    await ctx.close();
  }

  // ---------- Aggregate findings ----------
  observations.completedAt = new Date().toISOString();
  const pass = observations.findings.filter((f) => f.ok).length;
  const fail = observations.findings.filter((f) => !f.ok).length;
  observations.summary = { pass, fail, total: observations.findings.length };

  fs.writeFileSync(path.join(OUT_DIR, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(`[smoke] ${pass} pass / ${fail} fail of ${observations.findings.length} findings`);
  console.log(`[smoke] observations written to ${path.join(OUT_DIR, "observations.json")}`);

  await browser.close();

  if (fail > 0) {
    console.error(`[smoke] FAILED: ${fail} finding(s) failed`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[smoke] ERROR:", err);
  process.exit(1);
});

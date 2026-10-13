import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";

const APP_URL = process.env.APP_URL || "http://localhost:4030";
const SEED = process.env.SEED_PASSWORD;
const OUT = process.env.OUT_DIR || "/tmp/era5-logs";
fs.mkdirSync(OUT, { recursive: true });
const findings: { name: string; ok: boolean; detail?: string }[] = [];
function add(name: string, ok: boolean, detail?: string) {
  findings.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} :: ${detail || ""}`);
}

async function loginAs(ctx: BrowserContext, email: string) {
  const csrfRes = await ctx.request.get(`${APP_URL}/api/auth/csrf`);
  const csrf = (await csrfRes.json()).csrfToken;
  await ctx.request.post(`${APP_URL}/api/auth/callback/credentials`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    form: { email, password: SEED, csrfToken: csrf, callbackUrl: `${APP_URL}/` },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const session = await (await ctx.request.get(`${APP_URL}/api/auth/session`)).json();
  return session;
}

const browser: Browser = await chromium.launch({ headless: true });
async function run(name: string, email: string, fn: (ctx: BrowserContext, page: Page) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const session = await loginAs(ctx, email);
  if (!session?.user) {
    add(`${name}_login`, false, `no session for ${email}`);
    await ctx.close();
    return;
  }
  add(`${name}_login`, true, `email=${session.user.email} role=${session.user.role}`);
  try {
    await fn(ctx, page);
  } catch (e) {
    add(`${name}_flow`, false, (e as Error).message);
  }
  await ctx.close();
}

// SYSTEM_ADMIN: full access
await run("system_admin", "admin@superadmin.com", async (ctx, page) => {
  await page.goto(`${APP_URL}/logs`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/01-system-admin-logs.png`, fullPage: true });
  const tenantCol = await page.getByRole("columnheader", { name: "Tenant" }).count();
  add("system_admin_tenant_column", tenantCol > 0, `cols=${tenantCol}`);
  const listRes = await ctx.request.get(`${APP_URL}/api/logs?type=api`);
  add("system_admin_api_logs_list", listRes.status() === 200, `status=${listRes.status()}`);
  const apiJson = await listRes.json();
  const firstId = apiJson.items?.[0]?.id;
  if (firstId) {
    const detail = await ctx.request.get(`${APP_URL}/api/logs/api/${firstId}`);
    const dJson = await detail.json();
    add("system_admin_api_detail", detail.status() === 200 && !!dJson.tenantId, `status=${detail.status()} tenant=${dJson.tenant?.name}`);
  }
  // Webhook tab via API
  const wh = await ctx.request.get(`${APP_URL}/api/logs?type=webhook`);
  const whJson = await wh.json();
  const whFirst = whJson.items?.[0]?.id;
  if (whFirst) {
    const whDetail = await ctx.request.get(`${APP_URL}/api/logs/webhook/${whFirst}`);
    const wdJson = await whDetail.json();
    add("system_admin_webhook_detail", whDetail.status() === 200 && !!wdJson.tenantId, `status=${whDetail.status()}`);
  }
});

// TENANT ADMIN (Default Org): restricted access
await run("tenant_admin_default", "admin@default.com", async (ctx) => {
  const list = await ctx.request.get(`${APP_URL}/api/logs?type=api&tenantId=cmv337nob0001t25hbbyuq8tk`);
  add("tenant_admin_default_filter", list.status() === 200, `status=${list.status()}`);
  const listNoFilter = await ctx.request.get(`${APP_URL}/api/logs?type=api`);
  add("tenant_admin_default_blocked_global", listNoFilter.status() === 403, `status=${listNoFilter.status()}`);
  const cross = await ctx.request.get(`${APP_URL}/api/logs?type=api&tenantId=acme`);
  add("tenant_admin_default_blocked_cross", cross.status() === 403, `status=${cross.status()}`);
  // Direct detail access: pick an API log owned by a different tenant (if any)
  const all = await (await ctx.request.get(`${APP_URL}/api/logs?type=api&tenantId=cmv337nob0001t25hbbyuq8tk`)).json();
  const id = all.items?.[0]?.id;
  if (id) {
    const detail = await ctx.request.get(`${APP_URL}/api/logs/api/${id}?tenantId=cmv337nob0001t25hbbyuq8tk`);
    add("tenant_admin_default_detail_own", detail.status() === 200, `status=${detail.status()}`);
  }
  // NULL-owned log must be 404 for tenant admin
  const nullDetail = await ctx.request.get(`${APP_URL}/api/logs/webhook/cmv6p1fil0006nt5hlsyvpl1m?tenantId=cmv337nob0001t25hbbyuq8tk`);
  add("tenant_admin_default_null_owned_404", nullDetail.status() === 404, `status=${nullDetail.status()}`);
});

// TENANT ADMIN (Acme): cannot see Default Org logs
await run("tenant_admin_acme", "admin@acme.com", async (ctx) => {
  const own = await ctx.request.get(`${APP_URL}/api/logs?type=api&tenantId=acme`);
  const ownJson = await own.json();
  add("tenant_admin_acme_own_tenant", own.status() === 200 && ownJson.items?.length === 0, `status=${own.status()} items=${ownJson.items?.length}`);
  const noFilter = await ctx.request.get(`${APP_URL}/api/logs?type=api`);
  add("tenant_admin_acme_blocked_global", noFilter.status() === 403, `status=${noFilter.status()}`);
  // Try to access a Default Org log id directly
  const sysAll = await (await ctx.request.get(`${APP_URL}/api/logs?type=api&tenantId=cmv337nob0001t25hbbyuq8tk`)).json();
  const someId = sysAll.items?.[0]?.id;
  if (someId) {
    const detail = await ctx.request.get(`${APP_URL}/api/logs/api/${someId}?tenantId=acme`);
    add("tenant_admin_acme_blocked_other_tenant_detail", detail.status() === 403 || detail.status() === 404, `status=${detail.status()}`);
  }
});

// AGENT: cannot access detailed diagnostics
await run("agent", "agent@default.com", async (ctx) => {
  const list = await ctx.request.get(`${APP_URL}/api/logs?type=api`);
  add("agent_logs_blocked", list.status() === 403, `status=${list.status()}`);
});

fs.writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
const fail = findings.filter((f) => !f.ok).length;
console.log(`Findings: ${findings.length - fail}/${findings.length} pass`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);

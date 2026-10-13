import { chromium } from '@playwright/test';
import fs from 'node:fs';
const APP_URL = process.env.APP_URL || 'http://localhost:4030';
const SEED = process.env.SEED_PASSWORD;
const OUT = process.env.OUT_DIR || '/tmp/era5-inbox';
fs.mkdirSync(OUT, { recursive: true });
const findings = [];
function add(name, ok, detail) { findings.push({ name, ok, detail }); console.log(`  [${ok?'PASS':'FAIL'}] ${name} :: ${detail||''}`); }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const apiCalls = [];
page.on('request', r => { if (r.url().includes('/api/')) apiCalls.push({ method: r.method(), url: r.url(), postData: r.postData() }); });
page.on('response', async r => { if (r.url().includes('/api/')) { const last = [...apiCalls].reverse().find(x => x.url === r.url() && x.method === r.request().method() && x.status === undefined); if (last) { last.status = r.status(); try { last.body = (await r.text()).slice(0, 400); } catch {} } } });

// Use Playwright's form submit which the existing browser smoke uses.
await page.goto(`${APP_URL}/login`, { waitUntil: 'domcontentloaded' });
const csrfRes = await ctx.request.get(`${APP_URL}/api/auth/csrf`);
const csrf = (await csrfRes.json()).csrfToken;
const res = await ctx.request.post(`${APP_URL}/api/auth/callback/credentials`, {
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
  form: { email: 'admin@default.com', password: SEED, csrfToken: csrf, callbackUrl: `${APP_URL}/` },
  maxRedirects: 0,
  failOnStatusCode: false,
});
await res.text();
const session = await ctx.request.get(`${APP_URL}/api/auth/session`);
const sessionJson = await session.json();
add('admin_default_session', !!sessionJson?.user?.email, `email=${sessionJson?.user?.email} role=${sessionJson?.user?.role}`);

const conversationId = 'cmv66yzfv0002at5hu36ya67v';
const tenantId = 'cmv337nob0001t25hbbyuq8tk';
await page.goto(`${APP_URL}/t/${tenantId}/conversations?c=${conversationId}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/01-inbox-thread.png`, fullPage: true });

const input = page.getByPlaceholder(/Type a message/i).first();
const hasInput = await input.count() > 0;
add('composer_present', hasInput, 'composer rendered');
if (hasInput) {
  const text = 'ERA5 Inbox E2E ' + new Date().toISOString();
  await input.fill(text);
  await page.screenshot({ path: `${OUT}/02-inbox-composed.png`, fullPage: true });
  const sendBtn = page.locator('button').filter({ has: page.locator('svg.lucide-send') });
  await sendBtn.first().click();
  await page.waitForTimeout(3000);
  const after = apiCalls.filter(c => c.url.endsWith('/messages') && c.method === 'POST');
  const last = after[after.length - 1];
  add('inbox_send_requested', !!last, `count=${after.length} status=${last?.status} body=${(last?.body||'').slice(0,160)}`);
  await page.screenshot({ path: `${OUT}/03-inbox-after.png`, fullPage: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/04-inbox-after-reload.png`, fullPage: true });
  const body = await page.textContent('body');
  add('message_persists_after_reload', body && body.includes('ERA5 Inbox E2E'), 'contains-sent-text');
}

fs.writeFileSync(`${OUT}/api-calls.json`, JSON.stringify(apiCalls.slice(-40), null, 2));
fs.writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
const fail = findings.filter(f => !f.ok).length;
console.log(`Findings: ${findings.length - fail}/${findings.length} pass`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);

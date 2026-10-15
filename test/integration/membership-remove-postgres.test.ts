/**
 * WA-FIX-001 — Real HTTP + real PostgreSQL verification.
 *
 * Runs against the live dev server (:4020) using throwaway, fully-reversible
 * fixtures created and deleted by this script. NEVER touches production/seed
 * data. Proves cases A/B/C/D/E/F from the packet end-to-end plus historical
 * data integrity.
 *
 * Usage: npx tsx test/integration/membership-remove-postgres.test.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";

const BASE = process.env.WBA_TEST_BASE_URL ?? "http://127.0.0.1:4020";
const PASSWORD = "WA-FIX-001-fixture-pw";
const HOST = new URL(BASE).host;

type Check = { label: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(label: string, ok: boolean, detail?: string) {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
}

const runId = `wafix001${Date.now()}`;
const T = `${runId}_tenant`;
const T2 = `${runId}_tenant2`;
// Fixture identities must be valid emails: the credentials login schema enforces z.string().email().
const U_SYSADMIN = `${runId}_sys@fixture.test`;
const U_ADMIN = `${runId}_admin@fixture.test`;
const U_ADMIN2 = `${runId}_admin2@fixture.test`;
const U_AGENT = `${runId}_agent@fixture.test`;

async function main() {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
  const { prisma } = await import("@/lib/prisma");
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ---- Fixtures (reversible) -------------------------------------------
  await prisma.tenant.create({ data: { id: T, name: `${runId} Fixture Org` } });
  const mkUser = (email: string, role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT") =>
    prisma.user.create({ data: { email, name: email, passwordHash: hash, role, active: true } });
  await mkUser(U_SYSADMIN, "SYSTEM_ADMIN"); // identity only; session via login(U_SYSADMIN)
  const admin = await mkUser(U_ADMIN, "ADMIN");
  const admin2 = await mkUser(U_ADMIN2, "ADMIN");
  const agent = await mkUser(U_AGENT, "AGENT");

  const mkMem = (userId: string, tenantId = T) =>
    prisma.tenantMembership.create({ data: { userId, tenantId }, select: { id: true } });
  await mkMem(admin.id);
  let memAdmin2 = await mkMem(admin2.id);
  await mkMem(agent.id);

  // Historical data owned by agent (contact + assigned conversation) that must
  // survive the membership removal untouched.
  const contact = await prisma.contact.create({
    data: { tenantId: T, waId: `${runId}-wa` },
    select: { id: true },
  });
  const conv = await prisma.conversation.create({
    data: { tenantId: T, contactId: contact.id, assignedUserId: agent.id },
    select: { id: true },
  });

  // ---- HTTP helpers ----------------------------------------------------
  function makeJar() {
    const jar = new Map<string, string>();
    const header = () => [...jar.values()].join("; ");
    const absorb = (res: Response) => {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.trim());
      }
    };
    return { header, absorb, jar };
  }

  async function login(email: string) {
    const jar = makeJar();
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { Host: HOST } });
    jar.absorb(csrfRes);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

    const body = new URLSearchParams({ csrfToken, email, password: PASSWORD, callbackUrl: `${BASE}/`, json: "true" });
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header(), Host: HOST },
      body,
      redirect: "manual",
    });
    jar.absorb(res);

    // Confirm the session really authenticated as the expected user.
    const sessRes = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: jar.header(), Host: HOST } });
    const sess = (await sessRes.json()) as { user?: { email?: string; role?: string } };
    return { cookie: jar.header(), email: sess.user?.email ?? null, role: sess.user?.role ?? null };
  }

  async function api(cookie: string, path: string, init: RequestInit = {}) {
    return fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, Host: HOST, ...(init.headers || {}) },
    });
  }

  const sys = await login(U_SYSADMIN);
  const adminSess = await login(U_ADMIN);
  const agentSess = await login(U_AGENT);
  check(
    "login: sysAdmin/admin/agent sessions authenticated as themselves",
    sys.email === U_SYSADMIN && adminSess.email === U_ADMIN && agentSess.email === U_AGENT,
    `sys=${sys.email} admin=${adminSess.email} agent=${agentSess.email}`,
  );

  // ---- E. Unauthorized callers -----------------------------------------
  {
    const res = await api(adminSess.cookie, `/api/tenants/${T}/memberships?userId=${agent.id}`, { method: "DELETE" });
    check("E. tenant ADMIN cannot remove members (403)", res.status === 403, `status=${res.status}`);
    const stillThere = await prisma.tenantMembership.findUnique({ where: { userId_tenantId: { userId: agent.id, tenantId: T } } });
    check("E. agent membership intact after forbidden attempt", !!stillThere);
  }
  {
    const res = await fetch(`${BASE}/api/tenants/${T}/memberships?userId=${agent.id}`, { method: "DELETE", headers: { Host: HOST }, redirect: "manual" });
    check("E. anonymous cannot remove members (401)", res.status === 401, `status=${res.status}`);
  }
  {
    const res = await api(agentSess.cookie, `/api/tenants/${T}/memberships?userId=${admin.id}`, { method: "DELETE" });
    check("E. AGENT cannot remove members (403)", res.status === 403, `status=${res.status}`);
  }

  // ---- D (pre). agent CAN read tenant contacts with active session ------
  {
    const res = await api(agentSess.cookie, `/api/tenants/${T}/contacts`);
    check("D. agent has tenant access before removal (200)", res.status === 200, `status=${res.status}`);
  }

  // ---- B. Last-admin protection ----------------------------------------
  {
    await prisma.tenantMembership.delete({ where: { id: memAdmin2.id } }); // admin becomes sole admin
    const res = await api(sys.cookie, `/api/tenants/${T}/memberships?userId=${admin.id}`, { method: "DELETE" });
    check("B. removing LAST administrator rejected (409)", res.status === 409, `status=${res.status}`);
    const stillThere = await prisma.tenantMembership.findUnique({ where: { userId_tenantId: { userId: admin.id, tenantId: T } } });
    check("B. last admin membership preserved after rejection", !!stillThere);
    memAdmin2 = await mkMem(admin2.id); // restore second admin
  }

  // ---- F. Concurrency: two simultaneous attempts to remove the last admin
  {
    await prisma.tenantMembership.delete({ where: { id: memAdmin2.id } }); // admin is now sole admin
    const [r1, r2] = await Promise.all([
      api(sys.cookie, `/api/tenants/${T}/memberships?userId=${admin.id}`, { method: "DELETE" }),
      api(sys.cookie, `/api/tenants/${T}/memberships?userId=${admin.id}`, { method: "DELETE" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check("F. concurrent last-admin removals both rejected (409)", statuses[0] === 409 && statuses[1] === 409, `statuses=${statuses}`);
    const remaining = await prisma.tenantMembership.findUnique({ where: { userId_tenantId: { userId: admin.id, tenantId: T } } });
    check("F. sole admin survives concurrent removal attempts", !!remaining);
    memAdmin2 = await mkMem(admin2.id); // restore second admin
  }

  // ---- F2. Concurrency (strong): two DIFFERENT admins removed at once,
  //         tenant has exactly 2 admins. The advisory xact lock must serialize
  //         so exactly one succeeds and one admin always survives.
  {
    const [r1, r2] = await Promise.all([
      api(sys.cookie, `/api/tenants/${T}/memberships?userId=${admin.id}`, { method: "DELETE" }),
      api(sys.cookie, `/api/tenants/${T}/memberships?userId=${admin2.id}`, { method: "DELETE" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check("F2. exactly one concurrent admin removal wins (200 + 409)", statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses}`);
    const survivorCount = await prisma.tenantMembership.count({
      where: { tenantId: T, user: { role: "ADMIN", active: true } },
    });
    check("F2. exactly one administrator survives the race", survivorCount === 1, `survivingAdmins=${survivorCount}`);
  }

  // ---- A. Allowed removal of an AGENT membership -----------------------
  {
    const res = await api(sys.cookie, `/api/tenants/${T}/memberships?userId=${agent.id}`, { method: "DELETE" });
    check("A. SYSTEM_ADMIN removes agent membership (200)", res.status === 200, `status=${res.status}`);
    const gone = await prisma.tenantMembership.findUnique({ where: { userId_tenantId: { userId: agent.id, tenantId: T } } });
    check("A. agent membership deleted from DB", !gone);
    const userStill = await prisma.user.findUnique({ where: { id: agent.id }, select: { id: true } });
    check("INVARIANT. User row intact after membership removal", !!userStill);
  }

  // ---- Historical data integrity ---------------------------------------
  {
    const convStill = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { id: true, assignedUserId: true } });
    check("INVARIANT. historical conversation + assignment preserved", !!convStill && convStill.assignedUserId === agent.id);
    const contactStill = await prisma.contact.findUnique({ where: { id: contact.id }, select: { id: true } });
    check("INVARIANT. historical contact preserved", !!contactStill);
  }

  // ---- D (post). Revoked access with an EXISTING session ---------------
  {
    const res = await api(agentSess.cookie, `/api/tenants/${T}/contacts`);
    check("D. agent tenant access revoked after removal (existing session, 403)", res.status === 403, `status=${res.status}`);
  }

  // ---- C. Multi-tenant: user in two orgs keeps the second --------------
  {
    await prisma.tenant.create({ data: { id: T2, name: `${runId} Second Org` } });
    await mkMem(agent.id, T2); // agent -> org-2
    await mkMem(agent.id, T); // re-add agent to org-1 so it belongs to BOTH
    const res = await api(sys.cookie, `/api/tenants/${T}/memberships?userId=${agent.id}`, { method: "DELETE" });
    check("C. remove agent from org-1 (200)", res.status === 200, `status=${res.status}`);
    const t2mem = await prisma.tenantMembership.findUnique({ where: { userId_tenantId: { userId: agent.id, tenantId: T2 } } });
    check("C. agent KEEPS membership in org-2", !!t2mem);
    const t2res = await api(agentSess.cookie, `/api/tenants/${T2}/contacts`);
    check("C. agent retains live access to org-2 (200)", t2res.status === 200, `status=${t2res.status}`);
  }

  // ---- Validation: non-existent membership -> 404 (no stray delete) -----
  {
    const res = await api(sys.cookie, `/api/tenants/${T}/memberships?userId=${agent.id}`, { method: "DELETE" });
    check("VALIDATION. removing already-absent membership -> 404", res.status === 404, `status=${res.status}`);
  }
  {
    const res = await api(sys.cookie, `/api/tenants/${T}/memberships`, { method: "DELETE" });
    check("VALIDATION. missing userId -> 400", res.status === 400, `status=${res.status}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.label));
    process.exitCode = 1;
  }
}

async function cleanup() {
  try {
    const { prisma } = await import("@/lib/prisma");
    await prisma.conversation.deleteMany({ where: { tenantId: { in: [T, T2] } } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { tenantId: { in: [T, T2] } } }).catch(() => {});
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [T, T2] } } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: { in: [T, T2] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: runId } } }).catch(() => {});
    const leftover = await prisma.user.count({ where: { email: { startsWith: runId } } });
    check("CLEANUP. all fixtures removed", leftover === 0, `leftoverUsers=${leftover}`);
    await prisma.$disconnect();
  } catch {
    /* best effort */
  }
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) process.exitCode = 1;
  });

import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const tenantMembershipFindUnique = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());
const tenantFindUnique = vi.hoisted(() => vi.fn());
const webhookDestinationFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMembership: { findUnique: tenantMembershipFindUnique },
    user: { findUnique: userFindUnique },
    tenant: { findUnique: tenantFindUnique },
    webhookDestination: { findMany: webhookDestinationFindMany },
  },
}));

describe("webhook destination authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webhookDestinationFindMany.mockResolvedValue([]);
    tenantMembershipFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
    tenantFindUnique.mockResolvedValue(null);
  });

  it("rejects unauthenticated API access", async () => {
    auth.mockResolvedValue(null);
    const { GET } = await import("@/app/api/tenants/[tenantId]/webhook-destinations/route");
    const response = await GET(new Request("https://example.test/api/tenants/tenant_1/webhook-destinations"), { params: Promise.resolve({ tenantId: "tenant_1" }) });
    expect(response.status).toBe(401);
  });

  it("allows SYSTEM_ADMIN with explicit tenant context without membership bypassing persistence ownership", async () => {
    auth.mockResolvedValue({ user: { id: "sys_1", role: "SYSTEM_ADMIN" } });
    userFindUnique.mockResolvedValue({ id: "sys_1", active: true, role: "SYSTEM_ADMIN" });
    tenantFindUnique.mockResolvedValue({ id: "tenant_1" });
    const { GET } = await import("@/app/api/tenants/[tenantId]/webhook-destinations/route");
    const response = await GET(new Request("https://example.test/api/tenants/tenant_1/webhook-destinations"), { params: Promise.resolve({ tenantId: "tenant_1" }) });
    expect(response.status).toBe(200);
    expect(webhookDestinationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant_1" } }));
  });

  it("rejects AGENT membership administration", async () => {
    auth.mockResolvedValue({ user: { id: "agent_1", role: "AGENT" } });
    tenantMembershipFindUnique.mockResolvedValue({ id: "m_1", user: { id: "agent_1", active: true, role: "AGENT" }, tenant: { id: "tenant_1", name: "Tenant" } });
    const { GET } = await import("@/app/api/tenants/[tenantId]/webhook-destinations/route");
    const response = await GET(new Request("https://example.test/api/tenants/tenant_1/webhook-destinations"), { params: Promise.resolve({ tenantId: "tenant_1" }) });
    expect(response.status).toBe(403);
  });

  it("rejects ADMIN without target tenant membership", async () => {
    auth.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });
    userFindUnique.mockResolvedValue({ id: "admin_1", active: true, role: "ADMIN" });
    tenantFindUnique.mockResolvedValue({ id: "tenant_2" });
    const { GET } = await import("@/app/api/tenants/[tenantId]/webhook-destinations/route");
    const response = await GET(new Request("https://example.test/api/tenants/tenant_2/webhook-destinations"), { params: Promise.resolve({ tenantId: "tenant_2" }) });
    expect(response.status).toBe(403);
  });

  it("rejects unauthenticated access to the suspended-delivery resolution route", async () => {
    auth.mockResolvedValue(null);
    const { POST } = await import("@/app/api/tenants/[tenantId]/webhook-destinations/[destinationId]/suspended/route");
    const response = await POST(new Request("https://example.test/api/tenants/tenant_1/webhook-destinations/dest_1/suspended", { method: "POST", body: "{}" }), { params: Promise.resolve({ tenantId: "tenant_1", destinationId: "dest_1" }) });
    expect(response.status).toBe(401);
  });

  it("rejects AGENT resolving suspended deliveries", async () => {
    auth.mockResolvedValue({ user: { id: "agent_1", role: "AGENT" } });
    tenantMembershipFindUnique.mockResolvedValue({ id: "m_1", user: { id: "agent_1", active: true, role: "AGENT" }, tenant: { id: "tenant_1", name: "Tenant" } });
    const { POST } = await import("@/app/api/tenants/[tenantId]/webhook-destinations/[destinationId]/suspended/route");
    const response = await POST(new Request("https://example.test/api/tenants/tenant_1/webhook-destinations/dest_1/suspended", { method: "POST", body: "{}" }), { params: Promise.resolve({ tenantId: "tenant_1", destinationId: "dest_1" }) });
    expect(response.status).toBe(403);
  });

  it("rejects cross-tenant ADMIN resolving suspended deliveries", async () => {
    auth.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });
    userFindUnique.mockResolvedValue({ id: "admin_1", active: true, role: "ADMIN" });
    tenantFindUnique.mockResolvedValue({ id: "tenant_2" });
    const { POST } = await import("@/app/api/tenants/[tenantId]/webhook-destinations/[destinationId]/suspended/route");
    const response = await POST(new Request("https://example.test/api/tenants/tenant_2/webhook-destinations/dest_1/suspended", { method: "POST", body: "{}" }), { params: Promise.resolve({ tenantId: "tenant_2", destinationId: "dest_1" }) });
    expect(response.status).toBe(403);
  });
});

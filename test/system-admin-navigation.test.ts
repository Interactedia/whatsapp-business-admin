import { describe, expect, it } from "vitest";
import { visibleNavItems, isNavActive, navHref, NAV_ITEMS } from "@/components/shell/nav";

describe("SYSTEM_ADMIN navigation scope", () => {
  it("SYSTEM_ADMIN sees only the administration section (Dashboard, Tenants, Users)", () => {
    const items = visibleNavItems("SYSTEM_ADMIN");
    const labels = items.map((i) => `${i.label}:${navHref(i, null)}`).sort();
    expect(labels).toEqual(["Dashboard:/admin", "Tenants:/admin/tenants", "Users:/admin/users"]);
    // No operational workspace menus leak to SYSTEM_ADMIN.
    expect(items.some((i) => i.tenantScoped)).toBe(false);
  });

  it("tenant ADMIN sees operational + admin menus but never system-admin menus", () => {
    const items = visibleNavItems("ADMIN");
    expect(items.some((i) => i.systemAdminOnly)).toBe(false);
    expect(items.some((i) => i.key === "conversations")).toBe(true);
    expect(items.some((i) => i.key === "settings")).toBe(true);
  });

  it("tenant AGENT sees only non-admin operational menus", () => {
    const items = visibleNavItems("AGENT");
    expect(items.some((i) => i.adminOnly)).toBe(false);
    expect(items.some((i) => i.systemAdminOnly)).toBe(false);
    expect(items.some((i) => i.key === "conversations")).toBe(true);
  });

  it("/admin nav item is active only on exact /admin, not on /admin/tenants", () => {
    const adminItem = NAV_ITEMS.find((i) => i.key === "/admin")!;
    expect(isNavActive(adminItem, "/admin", null)).toBe(true);
    expect(isNavActive(adminItem, "/admin/tenants", null)).toBe(false);
  });

  it("/admin/tenants nav item is active on /admin/tenants and sub-paths", () => {
    const tenantsItem = NAV_ITEMS.find((i) => i.key === "/admin/tenants")!;
    expect(isNavActive(tenantsItem, "/admin/tenants", null)).toBe(true);
    expect(isNavActive(tenantsItem, "/admin/tenants/x", null)).toBe(true);
    expect(isNavActive(tenantsItem, "/admin", null)).toBe(false);
  });
});

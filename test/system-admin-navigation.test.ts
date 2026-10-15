import { describe, expect, it } from "vitest";
import { visibleNavItems, isNavActive, navHref, NAV_ITEMS, groupNavItems } from "@/components/shell/nav";

describe("SYSTEM_ADMIN navigation scope", () => {
  it("SYSTEM_ADMIN sees only the administration section", () => {
    const items = visibleNavItems("SYSTEM_ADMIN");
    const labels = items.map((i) => `${i.label}:${navHref(i, null)}`).sort();
    expect(labels).toEqual([
      "Dashboard:/admin",
      "Logs:/logs",
      "Queues:/admin/queue-observability",
      "Tenants:/admin/tenants",
      "Users:/admin/users",
    ]);
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

  it("/admin/tenants nav item is active only on exact /admin/tenants, not on /admin", () => {
    const tenantsItem = NAV_ITEMS.find((i) => i.key === "/admin/tenants")!;
    expect(isNavActive(tenantsItem, "/admin/tenants", null)).toBe(true);
    expect(isNavActive(tenantsItem, "/admin/tenants/x", null)).toBe(false);
    expect(isNavActive(tenantsItem, "/admin", null)).toBe(false);
  });
});

describe("WA-UI-009 sidebar grouping", () => {
  it("groups the full ADMIN menu into the four approved sections without losing items", () => {
    const sections = groupNavItems(visibleNavItems("ADMIN"));
    expect(sections.map((s) => s.group)).toEqual([
      "Principal",
      "Atención",
      "Campañas y automatización",
      "Administración",
    ]);
    expect(sections.map((s) => s.items.map((i) => i.key))).toEqual([
      ["/"],
      ["conversations", "contacts"],
      ["templates", "flows", "submissions", "broadcasts"],
      ["settings", "settings/webhooks", "developer", "users"],
    ]);
  });

  it("keeps grouping consistent with role visibility (AGENT never sees admin-only groups' restricted items)", () => {
    const sections = groupNavItems(visibleNavItems("AGENT"));
    expect(sections.map((s) => s.group)).toEqual(["Principal", "Atención", "Campañas y automatización"]);
    const allItems = sections.flatMap((s) => s.items);
    expect(allItems.some((i) => i.adminOnly)).toBe(false);
    // Routes are untouched by grouping.
    expect(navHref(NAV_ITEMS.find((i) => i.key === "conversations")!, "acme")).toBe("/t/acme/conversations");
  });

  it("SYSTEM_ADMIN items render ungrouped (no section headers added to system administration)", () => {
    const sections = groupNavItems(visibleNavItems("SYSTEM_ADMIN"));
    expect(sections).toHaveLength(1);
    expect(sections[0].group).toBeNull();
    expect(sections[0].items).toHaveLength(5);
  });
});

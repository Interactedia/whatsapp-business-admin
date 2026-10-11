import {
  LayoutDashboard,
  MessageSquare,
  Users,
  LayoutTemplate,
  Megaphone,
  Settings,
  Code2,
  UserCog,
  ListChecks,
  Workflow,
  Building2,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  /** Path without tenantId. Resolved to `/t/:tenantId/<key>` when a tenant is active. */
  key: string;
  /** Label visible in the sidebar. */
  label: string;
  /** Icon for the item. */
  icon: LucideIcon;
  /** Restrict the item to ADMIN users. */
  adminOnly?: boolean;
  /** Restrict the item to SYSTEM_ADMIN users. */
  systemAdminOnly?: boolean;
  /** True when this item is a tenant-scoped workspace resource. */
  tenantScoped?: boolean;
  /** True when the item is the dashboard and is never tenant-scoped. */
  global?: boolean;
};

/**
 * Canonical navigation items. The `key` is the resource path (e.g. `conversations`),
 * which the shell renders as `/t/:tenantId/conversations` once a tenant is selected.
 * Items marked `global` keep their absolute path and do not inject a tenant.
 */
export const NAV_ITEMS: NavItem[] = [
  // Tenant workspace (hidden from SYSTEM_ADMIN)
  { key: "/", label: "Dashboard", icon: LayoutDashboard, tenantScoped: true },
  { key: "conversations", label: "Inbox", icon: MessageSquare, tenantScoped: true },
  { key: "contacts", label: "Contacts", icon: Users, tenantScoped: true },
  { key: "templates", label: "Templates", icon: LayoutTemplate, adminOnly: true, tenantScoped: true },
  { key: "flows", label: "Flows", icon: Workflow, adminOnly: true, tenantScoped: true },
  { key: "submissions", label: "Submissions", icon: ListChecks, tenantScoped: true },
  { key: "broadcasts", label: "Broadcasts", icon: Megaphone, adminOnly: true, tenantScoped: true },
  { key: "settings", label: "Settings", icon: Settings, adminOnly: true, tenantScoped: true },
  { key: "developer", label: "API", icon: Code2, adminOnly: true, tenantScoped: true },
  { key: "users", label: "Users", icon: UserCog, adminOnly: true, tenantScoped: true },
  // System administration (SYSTEM_ADMIN only — no operational menus)
  { key: "/admin", label: "Dashboard", icon: LayoutDashboard, systemAdminOnly: true, global: true },
  { key: "/admin/tenants", label: "Tenants", icon: Building2, systemAdminOnly: true, global: true },
  { key: "/admin/users", label: "Users", icon: UserCog, systemAdminOnly: true, global: true },
];

/**
 * Build the href for a nav item given the current tenant context.
 * - `global` items keep their absolute path.
 * - `tenantScoped` items need an active tenantId; they fall back to `/inbox`
 *   (the canonical tenant selector entry) when no tenant is active.
 */
export function navHref(item: NavItem, activeTenantId: string | null): string {
  if (item.global) return item.key;
  if (item.tenantScoped) {
    if (activeTenantId) {
      // The Dashboard "key" of "/" means the tenant root, not "/t/:id//".
      if (item.key === "/") return `/t/${activeTenantId}`;
      return `/t/${activeTenantId}/${item.key}`;
    }
    return "/inbox";
  }
  return item.key;
}

/**
 * Compute whether a nav item is the "active" route given the current pathname.
 * Centralizes the active-match logic so the sidebar stays in sync with the URL.
 */
export function isNavActive(
  item: NavItem,
  pathname: string,
  activeTenantId: string | null,
): boolean {
  const href = navHref(item, activeTenantId);
  if (href === "/") return pathname === "/";
  if (href === "/inbox") return pathname === "/inbox";
  // Exact-match items must never light up on child routes.
  if (href === "/admin") return pathname === "/admin";
  // The tenant root (e.g. /t/abc) is the Dashboard — match it exactly, since
  // child routes like /t/abc/conversations already have their own items.
  if (activeTenantId && href === `/t/${activeTenantId}`) {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Nav items visible to a given role.
 * SYSTEM_ADMIN is a pure system administrator: only the system-administration
 * section (Dashboard /admin, Tenants, Users) is visible — no operational
 * tenant workspace menus. Tenant ADMIN sees admin + operational items;
 * AGENT sees only non-admin operational items.
 */
export function visibleNavItems(role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT"): NavItem[] {
  if (role === "SYSTEM_ADMIN") {
    return NAV_ITEMS.filter((i) => i.systemAdminOnly);
  }
  return NAV_ITEMS.filter((i) => {
    if (i.systemAdminOnly) return false;
    if (i.adminOnly) return role === "ADMIN";
    return true;
  });
}

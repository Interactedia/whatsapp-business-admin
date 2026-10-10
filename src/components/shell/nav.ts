import {
  LayoutDashboard,
  MessageSquare,
  Users,
  LayoutTemplate,
  Megaphone,
  ScrollText,
  Settings,
  Code2,
  UserCog,
  ListChecks,
  Workflow,
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
  { key: "/", label: "Dashboard", icon: LayoutDashboard, global: true },
  { key: "conversations", label: "Inbox", icon: MessageSquare, tenantScoped: true },
  { key: "contacts", label: "Contacts", icon: Users, tenantScoped: true },
  { key: "templates", label: "Templates", icon: LayoutTemplate, adminOnly: true, tenantScoped: true },
  { key: "flows", label: "Flows", icon: Workflow, adminOnly: true, tenantScoped: true },
  { key: "submissions", label: "Submissions", icon: ListChecks, tenantScoped: true },
  { key: "broadcasts", label: "Broadcasts", icon: Megaphone, adminOnly: true, tenantScoped: true },
  { key: "logs", label: "Logs", icon: ScrollText, adminOnly: true, tenantScoped: true },
  { key: "settings", label: "Settings", icon: Settings, adminOnly: true, tenantScoped: true },
  { key: "developer", label: "API", icon: Code2, adminOnly: true, tenantScoped: true },
  { key: "users", label: "Users", icon: UserCog, adminOnly: true, tenantScoped: true },
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
    if (activeTenantId) return `/t/${activeTenantId}/${item.key}`;
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
  return pathname === href || pathname.startsWith(`${href}/`);
}

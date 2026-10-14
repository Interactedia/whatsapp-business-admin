"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { MessageCircle, LogOut, ChevronDown, Menu, X, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { isNavActive, navHref, visibleNavItems } from "@/components/shell/nav";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { OrganizationSelector } from "@/components/tenant/organization-selector";
import type { TenantMembershipSummary } from "@/components/tenant/organization-selector";

type Props = {
  user: { name: string; email: string; role: "SYSTEM_ADMIN" | "ADMIN" | "AGENT" };
  memberships: TenantMembershipSummary[];
  activeTenantId: string | null;
  wabaConnected: boolean;
  phoneNumber: string | null;
  children: React.ReactNode;
};

export function AppShell({ user, memberships, activeTenantId, wabaConnected, phoneNumber, children }: Props) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // SYSTEM_ADMIN is a pure system administrator: only Dashboard/Tenants/Users
  // in the administration section — never the operational tenant workspace.
  const items = visibleNavItems(user.role);
  const isSystemAdmin = user.role === "SYSTEM_ADMIN";
  const initials = user.name
    .split(" ")
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  useEffect(() => setMobileNavOpen(false), [pathname]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setMobileNavOpen(false);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileNavOpen]);

  const navigation = (
    <>
      <nav className="flex-1 overflow-y-auto px-3 py-4 scroll-thin">
        <div className="space-y-1">
          {items.map((item) => {
            const href = navHref(item, activeTenantId);
            const active = isNavActive(item, pathname, activeTenantId);
            const Icon = item.icon;
            return (
              <Link
                key={item.label}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  active
                    ? "bg-primary/10 text-primary shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                )}
              >
                <Icon className={cn(
                  "h-[18px] w-[18px] shrink-0 transition-colors",
                  active ? "text-primary" : "text-slate-500 group-hover:text-slate-700"
                )} />
                <span>{item.label}</span>
                {active && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Sidebar Footer */}
      <div className="border-t border-slate-200/60 px-3 py-3">
        {isSystemAdmin ? (
          <div className="flex items-center gap-2.5 rounded-lg bg-primary/5 px-3 py-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-slate-900">System Administration</p>
              <p className="text-[11px] text-slate-500">Platform-wide access</p>
            </div>
            <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50" />
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2">
            <span className={cn(
              "h-2 w-2 rounded-full shadow-sm",
              wabaConnected ? "bg-emerald-500 shadow-emerald-500/50" : "bg-slate-400"
            )} />
            <span className="text-xs text-slate-500">
              {wabaConnected ? phoneNumber || "Connected" : "Not connected"}
            </span>
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-slate-50 text-foreground">
      {/* Desktop Sidebar - Modern Enterprise / Soft Minimalism */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200/60 bg-white lg:flex">
        {/* Logo Header */}
        <div className="flex h-16 items-center gap-3 border-b border-slate-200/60 px-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-900">
              WhatsApp Admin
            </h1>
            <p className="text-[11px] text-slate-500">
              {isSystemAdmin ? "Control Panel" : "Business Console"}
            </p>
          </div>
        </div>
        {navigation}
      </aside>

      {/* Mobile Navigation Overlay */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-[min(85vw,300px)] flex-col bg-white shadow-2xl"
          >
            {/* Mobile Header */}
            <div className="flex h-16 items-center gap-3 border-b border-slate-200/60 px-4 pt-[env(safe-area-inset-top)]">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
                <MessageCircle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-semibold tracking-tight text-slate-900">
                  WhatsApp Admin
                </h1>
                <p className="text-[11px] text-slate-500">Business Console</p>
              </div>
              <button
                className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-slate-100 active:bg-slate-200"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-5 w-5 text-slate-600" />
              </button>
            </div>
            {navigation}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200/60 bg-white px-4 pt-[max(0px,env(safe-area-inset-top))]">
          <div className="flex items-center gap-3">
            <button
              className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 lg:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            {isSystemAdmin ? (
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-slate-900">System Administration</span>
              </div>
            ) : (
              <>
                <OrganizationSelector memberships={memberships} activeTenantId={activeTenantId} />
                <span className="text-sm font-semibold text-slate-600 lg:hidden">WA Admin</span>
                {!wabaConnected && (
                  <Badge variant="warning" className="hidden gap-1 sm:inline-flex">
                    Connect your WhatsApp account in Settings
                  </Badge>
                )}
              </>
            )}
          </div>

          {/* User Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="User menu"
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-ring active:bg-slate-200"
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                    {initials || "U"}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden text-left leading-tight sm:block">
                  <div className="text-xs font-semibold text-slate-900">{user.name}</div>
                  <div className="text-[10px] text-slate-500">{user.role}</div>
                </div>
                <ChevronDown className="h-4 w-4 text-slate-400" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium text-slate-900">{user.name}</p>
                  <p className="text-xs text-slate-500">{user.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => signOut({ callbackUrl: "/login" })}
                className="text-red-600 focus:text-red-600"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Cerrar sesión
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Main Content - Soft Minimalism background */}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-slate-50 scroll-thin">
          {children}
        </main>
      </div>
    </div>
  );
}

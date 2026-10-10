"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { MessageCircle, LogOut, ChevronDown, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isNavActive, navHref } from "@/components/shell/nav";
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
  user: { name: string; email: string; role: "ADMIN" | "AGENT" };
  memberships: TenantMembershipSummary[];
  activeTenantId: string | null;
  wabaConnected: boolean;
  phoneNumber: string | null;
  children: React.ReactNode;
};

export function AppShell({ user, memberships, activeTenantId, wabaConnected, phoneNumber, children }: Props) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const items = NAV_ITEMS.filter((i) => !i.adminOnly || user.role === "ADMIN");
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
      <nav className="flex-1 space-y-1 overflow-y-auto p-2 scroll-thin">
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
                "flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors lg:min-h-0 lg:px-2.5 lg:py-1.5",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-3 text-xs text-muted-foreground lg:p-2">
        <div className="flex items-center gap-1.5 px-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", wabaConnected ? "bg-emerald-500" : "bg-muted-foreground/40")} />
          {wabaConnected ? phoneNumber || "Connected" : "Not connected"}
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <aside className="hidden w-52 shrink-0 flex-col border-r bg-card lg:flex">
        <div className="flex h-12 items-center gap-2 border-b px-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MessageCircle className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold">WA Admin</span>
        </div>
        {navigation}
      </aside>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-[min(84vw,320px)] flex-col bg-card shadow-xl"
          >
            <div className="flex min-h-14 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top)]">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <MessageCircle className="h-4 w-4" />
              </div>
              <span className="text-sm font-semibold">WA Admin</span>
              <button
                className="ml-auto flex h-11 w-11 items-center justify-center rounded-md hover:bg-accent"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {navigation}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center justify-between border-b bg-card px-2 py-1 pt-[max(0.25rem,env(safe-area-inset-top))] sm:px-4">
          <div className="flex items-center gap-2">
            <button
              className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-accent lg:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <OrganizationSelector memberships={memberships} activeTenantId={activeTenantId} />
            <span className="text-sm font-semibold lg:hidden">WA Admin</span>
            {!wabaConnected && (
              <Badge variant="warning" className="hidden gap-1 sm:inline-flex">
                Connect your WhatsApp account in Settings
              </Badge>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="User menu"
                className="flex items-center gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Avatar className="h-7 w-7">
                  <AvatarFallback>{initials || "U"}</AvatarFallback>
                </Avatar>
                <div className="hidden text-left leading-tight sm:block">
                  <div className="text-xs font-medium">{user.name}</div>
                  <div className="text-[10px] text-muted-foreground">{user.role}</div>
                </div>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => signOut({ callbackUrl: "/login" })}>
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-h-0 min-w-0 flex-1 overflow-auto scroll-thin">{children}</main>
      </div>
    </div>
  );
}

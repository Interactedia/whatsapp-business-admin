import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AdminDashboardClient } from "./admin-dashboard-client";

/**
 * System Administration Dashboard — exclusive to SYSTEM_ADMIN.
 * Platform-wide overview only; no operational tenant workspace metrics.
 * Authorization, data fetching, and privileged processing remain server-side.
 */
export default async function SystemAdminDashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  const [tenantCount, userCount, membershipCount, activeUserCount, conversationCount] = await Promise.all([
    prisma.tenant.count(),
    prisma.user.count(),
    prisma.tenantMembership.count(),
    prisma.user.count({ where: { active: true } }),
    prisma.conversation.count(),
  ]);

  const stats = [
    { key: "tenants" as const, value: tenantCount, href: "/admin/tenants" },
    { key: "users" as const, value: userCount, href: "/admin/users" },
    { key: "activeUsers" as const, value: activeUserCount, href: "/admin/users" },
    { key: "memberships" as const, value: membershipCount, href: "/admin/tenants" },
    { key: "conversations" as const, value: conversationCount, href: "/admin/tenants" },
  ];

  const adminLinks = [
    { key: "manageTenants" as const, href: "/admin/tenants" },
    { key: "manageUsers" as const, href: "/admin/users" },
    { key: "queuesOutbox" as const, href: "/admin/queue-observability" },
  ];

  return <AdminDashboardClient stats={stats} adminLinks={adminLinks} />;
}

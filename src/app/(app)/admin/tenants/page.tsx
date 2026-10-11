import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AdminTenantsClient } from "./admin-tenants-client";

export default async function AdminTenantsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "SYSTEM_ADMIN") redirect("/");

  return <AdminTenantsClient />;
}

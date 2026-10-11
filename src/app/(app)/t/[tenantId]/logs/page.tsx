import { redirect } from "next/navigation";
import { auth } from "@/auth";

export default async function TenantLogsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Legacy audit records do not carry tenant ownership, so tenant-scoped access fails closed.
  redirect("/");
}

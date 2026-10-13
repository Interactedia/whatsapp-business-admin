"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { MessageCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await signIn("credentials", { email, password, redirect: false });
      // Auth.js v5 returns { url: callbackUrl } on success WITHOUT an `error`
      // field, so we cannot rely on the signIn result alone. Verify the
      // session before navigating.
      const sessionRes = await fetch("/api/auth/session");
      const session = (await sessionRes.json()) as { user?: { email?: string } } | null;
      if (!session?.user?.email) {
        setError("Correo electrónico o contraseña incorrectos.");
        setLoading(false);
        return;
      }
      // Tell other tabs the session changed so they can refetch.
      try {
        const bc = new BroadcastChannel("next-auth");
        bc.postMessage({ event: "session", data: { trigger: "signIn" } });
        bc.close();
      } catch {
        // BroadcastChannel is unsupported in some browsers; safe to ignore.
      }
      router.push(params.get("callbackUrl") || "/");
      router.refresh();
    } catch {
      setError("Error al iniciar sesión. Verifica tus credenciales.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-3 safe-bottom sm:p-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xs sm:p-6">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">WhatsApp Business Admin</div>
            <div className="text-xs text-muted-foreground">Sign in to continue</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs font-medium text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Iniciando sesión…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}

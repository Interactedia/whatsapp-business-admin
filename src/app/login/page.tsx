"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { MessageCircle, AlertCircle, Shield, Zap } from "lucide-react";
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
    <div className="flex min-h-dvh">
      {/* Left panel - Branding (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-1/2 lg:flex-col lg:justify-center lg:bg-gradient-to-br lg:from-primary/5 lg:via-background lg:to-primary/10 lg:px-12 xl:px-16">
        <div className="space-y-6">
          {/* Logo and brand */}
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <MessageCircle className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                WhatsApp Business Admin
              </h1>
              <p className="text-sm text-muted-foreground">
                Panel de control empresarial
              </p>
            </div>
          </div>

          {/* Tagline */}
          <div className="space-y-4">
            <p className="text-3xl font-semibold leading-tight tracking-tight text-foreground xl:text-4xl">
              Gestiona tus conversaciones de negocio con confianza
            </p>
            <p className="text-base leading-relaxed text-muted-foreground">
              Administra mensajes, plantillas y contactos de WhatsApp desde un único panel de control profesional y seguro.
            </p>
          </div>

          {/* Feature highlights */}
          <div className="grid gap-4 pt-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                <Shield className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm text-muted-foreground">
                Conexión segura con la API oficial de Meta
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                <Zap className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm text-muted-foreground">
                Mensajes en tiempo real y reconciled state
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right panel - Login form */}
      <div className="flex w-full flex-col justify-center px-6 py-8 sm:px-8 lg:w-1/2 lg:px-12 xl:px-16">
        {/* Mobile logo */}
        <div className="mb-8 flex items-center justify-center gap-3 lg:hidden">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">
              WhatsApp Business Admin
            </h1>
            <p className="text-xs text-muted-foreground">Panel de control</p>
          </div>
        </div>

        <div className="mx-auto w-full max-w-sm space-y-8">
          {/* Form header */}
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Iniciar sesión
            </h2>
            <p className="text-sm text-muted-foreground">
              Ingresa tus credenciales para acceder al panel de control.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={onSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-sm font-medium text-foreground">
                Correo electrónico
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tu@empresa.com"
                required
                disabled={loading}
                className="h-11"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm font-medium text-foreground">
                Contraseña
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                className="h-11"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              className="h-11 w-full text-sm font-medium"
              disabled={loading}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Iniciando sesión…
                </span>
              ) : (
                "Iniciar sesión"
              )}
            </Button>
          </form>

          {/* Footer */}
          <p className="text-center text-xs text-muted-foreground">
            Acceso restringido a usuarios autorizados
          </p>
        </div>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/providers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/messages";

export const metadata: Metadata = {
  title: "WhatsApp Business Admin",
  description: "Manage templates, inbox, broadcasts and webhooks for the WhatsApp Cloud API.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read the locale preference server-side so <html lang> and the first client
  // render are correct without any post-hydration flash. Missing or invalid
  // cookie falls back to Spanish (the default locale).
  let locale: Locale = DEFAULT_LOCALE;
  try {
    const store = await cookies();
    const value = store.get(LOCALE_COOKIE)?.value;
    if (isLocale(value)) locale = value;
  } catch {
    // Outside a request context (e.g. some tooling) — keep the default.
  }

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}

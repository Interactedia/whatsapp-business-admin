"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  translate,
  type Locale,
} from "@/messages";

type I18nContextValue = {
  locale: Locale;
  /** Translate a key. `fallback` is used when the key is missing from the dictionary. */
  t: (key: string, fallback?: string) => string;
  /** Switch locale, persist it in a cookie and update <html lang>. */
  setLocale: (locale: Locale) => void;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Client-side i18n context.
 *
 * `initialLocale` comes from the server (root layout reads the cookie), so the
 * first client render matches the server render — no hydration mismatch and no
 * language flash on load. The cookie is re-read on mount only as a safety net
 * for trees rendered without an initialLocale (e.g. tests).
 */
export function LanguageProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);

  // Safety net: sync with the cookie once after mount when no initialLocale
  // was provided from the server. With initialLocale this is a no-op.
  useEffect(() => {
    if (initialLocale) return;
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`),
    );
    const value = match?.[1];
    if (isLocale(value) && value !== locale) setLocaleState(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    // 1 year, lax same-site — enough for a UI preference cookie.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next;
  }, []);

  // Keep <html lang> coherent after hydration-driven changes.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: string, fallback?: string) => translate(locale, key, fallback),
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <LanguageProvider>");
  return ctx;
}

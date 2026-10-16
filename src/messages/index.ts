import { es } from "./es";
import { en } from "./en";

export type Locale = "es" | "en";

/** Cookie that stores the user's UI language preference. */
export const LOCALE_COOKIE = "wa-locale";

/** The default and fallback locale (per docs/ui/visual-contract.md §13). */
export const DEFAULT_LOCALE: Locale = "es";

export type MessageKey = keyof typeof es;

const dictionaries: Record<Locale, Record<string, string>> = { es, en };

/** Narrow an untrusted string (e.g. a raw cookie value) to a Locale. */
export function isLocale(value: string | null | undefined): value is Locale {
  return value === "es" || value === "en";
}

/**
 * Translate a key in the given locale.
 * Fallback chain: locale dictionary → explicit fallback → Spanish → the key itself.
 * Never throws; an unknown key renders the fallback (or key), which keeps the
 * UI safe when a dictionary entry is missing.
 */
export function translate(locale: Locale, key: string, fallback?: string): string {
  return dictionaries[locale][key] ?? fallback ?? es[key as MessageKey] ?? key;
}

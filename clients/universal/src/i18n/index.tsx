import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { en, type Messages } from "./en";
import { es } from "./es";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

export const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const MESSAGES: Record<Locale, Messages> = { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, ko, es };

const STORAGE_KEY = "billie.locale";

/** A category's name in the interface language: built-in names are translated, the person's own are shown as typed. */
export function categoryLabel(m: Messages, name: string): string {
  return Object.prototype.hasOwnProperty.call(m.categories, name) ? (m.categories as Record<string, string>)[name] : name;
}

export const isLocale = (value: unknown): value is Locale => typeof value === "string" && (LOCALES as readonly string[]).includes(value);

/** Same rules as the Rails site: exact match, then Chinese script/region, then the base language. */
export function detectLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    const lower = preference.toLowerCase();
    const exact = LOCALES.find((locale) => locale.toLowerCase() === lower);
    if (exact) return exact;
    const parts = lower.split("-");
    if (parts[0] === "zh") {
      const traditional = parts.includes("hant") || (!parts.includes("hans") && parts.some((part) => ["tw", "hk", "mo"].includes(part)));
      return traditional ? "zh-TW" : "zh-CN";
    }
    const base = LOCALES.find((locale) => locale === parts[0]);
    if (base) return base;
  }
  return "en";
}

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage unavailable
  }
  return detectLocale(typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]);
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;
interface I18nValue { locale: Locale; setLocale: (locale: Locale) => void; m: Messages; t: Translate }

const I18nContext = createContext<I18nValue | null>(null);

export function interpolate(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initial ?? initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable
    }
    document.documentElement.lang = next;
  }, []);
  const value = useMemo<I18nValue>(() => {
    const m = MESSAGES[locale];
    const t: Translate = (key, vars) => {
      const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], m);
      return interpolate(typeof text === "string" ? text : key, vars);
    };
    return { locale, setLocale, m, t };
  }, [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function LanguageSelect({ id, onChange }: { id: string; onChange?: (locale: Locale) => void }) {
  const { locale, setLocale } = useI18n();
  return (
    <select id={id} value={locale} onChange={(event) => { const next = event.target.value as Locale; setLocale(next); onChange?.(next); }}>
      {LOCALES.map((code) => <option key={code} value={code}>{MESSAGES[code].languageName}</option>)}
    </select>
  );
}

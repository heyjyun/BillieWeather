// Country / Region choices for a new account. Must equal Rails' UsageRegion::CODES
// (app/models/usage_region.rb) and the identity service's list; test/register.test.tsx compares them.
export const GLOBAL_CITIZEN = "XG";
/** For people outside the supported countries. */
export const OTHER = "XO";
export const REGION_CODES: readonly string[] = `
AE AR AT AU BD BE BG BR CA CH CL CN CO CY CZ DE DK EE EG ES FI FR GB GR HK HR HU ID IE IL IN IT JP KE KR KW
LK LT LU LV MA MO MT MX MY NG NL NO NZ PE PH PK PL PR PT QA RO RU SA SE SG SI SK TH TR TW UA US VN ZA
`.trim().split(/\s+/);

export interface RegionOption { code: string; label: string }

// Only one Korea is offered, so it is shown without "South" (Intl would say "South Korea").
const KOREA: Record<string, string> = { en: "Korea", es: "Corea", ko: "한국" };
const OTHER_NAMES: Record<string, string> = { en: "Other", es: "Otro", ja: "その他", ko: "기타", zh: "其他" };

/** A supported code's name in the interface language (Korea and Other are the app's own names). */
export function regionLabel(code: string, locale: string, names?: Intl.DisplayNames | null): string {
  const language = locale.split("-")[0];
  if (code === OTHER) return OTHER_NAMES[language] ?? OTHER_NAMES.en;
  if (code === "KR" && KOREA[language]) return KOREA[language];
  try {
    return (names ?? new Intl.DisplayNames([locale], { type: "region" })).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Global Citizen first, Other second, then every region by its name in the interface language (as on the website). */
export function regionOptions(locale: string, globalCitizen: string): RegionOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    names = null;
  }
  const standard = REGION_CODES.map((code) => ({ code, label: regionLabel(code, locale, names) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  return [{ code: GLOBAL_CITIZEN, label: globalCitizen }, { code: OTHER, label: regionLabel(OTHER, locale) }, ...standard];
}

/** Matches the name or the two-letter code, ignoring case and accents. */
export function matchesRegion(option: RegionOption, query: string): boolean {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const q = fold(query.trim());
  return q === "" || fold(option.label).includes(q) || option.code.toLowerCase() === q;
}

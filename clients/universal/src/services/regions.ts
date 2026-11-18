// Country / Region choices for a new account. Must equal Rails' UsageRegion::CODES
// (app/models/usage_region.rb) and the identity service's list; test/register.test.tsx compares them.
export const GLOBAL_CITIZEN = "XG";
export const REGION_CODES: readonly string[] = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY
BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK
FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR
IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK
ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM
PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF
TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/);

export interface RegionOption { code: string; label: string }

/** Global Citizen first, then every region by its name in the interface language (as on the website). */
export function regionOptions(locale: string, globalCitizen: string): RegionOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    names = null;
  }
  const label = (code: string) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
  const standard = REGION_CODES.map((code) => ({ code, label: label(code) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  return [{ code: GLOBAL_CITIZEN, label: globalCitizen }, ...standard];
}

/** Matches the name or the two-letter code, ignoring case and accents. */
export function matchesRegion(option: RegionOption, query: string): boolean {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const q = fold(query.trim());
  return q === "" || fold(option.label).includes(q) || option.code.toLowerCase() === q;
}

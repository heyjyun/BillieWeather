// Settings › Account & security, Appearance, and Transaction & category rules.
import { useState } from "react";
import { InlineDialog } from "../components/common";
import { radioGroupKeys } from "../hooks/useFocus";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, LanguageSelect, useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { NICKNAME_MAX, normalizeNickname, validateNickname, type NicknameProblem } from "../services/profile";
import { regionLabel } from "../services/regions";
import { openExternal } from "../services/session";
import { savedTheme, setTheme, type ThemeChoice } from "../services/theme";
import type { SectionProps } from "./registry";

function regionName(code: string | null | undefined, locale: string, globalCitizen: string): string {
  if (!code) return "—";
  if (code === "XG") return globalCitizen;
  return regionLabel(code, locale);
}

export function AccountSection() {
  const { m, locale } = useI18n();
  const { account, offline, signOut, signOutOthers, savePreferences } = useAccount();
  const [nickname, setNickname] = useState(account?.nickname ?? "");
  const [accountStatus, setAccountStatus] = useState<"saved" | "saveFailed" | null>(null);
  const [nicknameProblem, setNicknameProblem] = useState<NicknameProblem | null>(null);
  const [askOthers, setAskOthers] = useState(false);
  const [othersStatus, setOthersStatus] = useState<string | null>(null);
  const x = m.settings;
  const n = m.personal.nickname;

  // Any language, not unique; it can be changed but not cleared (the server enforces the same rule).
  function saveNickname() {
    const problem = validateNickname(nickname);
    setNicknameProblem(problem);
    if (problem) return setAccountStatus(null);
    const next = normalizeNickname(nickname)!;
    setNickname(next);
    void save({ nickname: next });
  }

  async function save(preferences: Parameters<typeof savePreferences>[0]) {
    setOthersStatus(null);
    try {
      await savePreferences(preferences);
      setAccountStatus("saved");
    } catch {
      setAccountStatus("saveFailed");
    }
  }

  async function endOtherSessions() {
    setAskOthers(false);
    try {
      await signOutOthers();
      setOthersStatus(x.othersDone);
    } catch {
      setOthersStatus(x.othersFailed);
    }
  }

  const memberSince = account?.registeredAt ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(account.registeredAt)) : "—";

  return (
    <section className="bw-panel bw-account" aria-labelledby="account-heading">
      <h2 id="account-heading">{x.account}</h2>
      {offline && <p className="bw-message bw-message-warn">{x.offlineAccount}</p>}
      <dl className="bw-account-facts">
        <div><dt>{x.email}</dt><dd>{account?.email}</dd></div>
        <div><dt>{x.memberSince}</dt><dd>{memberSince}</dd></div>
        <div><dt>{x.region}</dt><dd>{regionName(account?.usageRegion, locale, x.globalCitizen)}</dd></div>
      </dl>
      <div className="bw-account-form">
        <label className="bw-field"><span>{n.label}<span className="bw-required-mark" aria-hidden="true">*</span><span className="bw-visually-hidden"> ({n.required})</span></span>
          <input value={nickname} maxLength={NICKNAME_MAX} placeholder={n.placeholder} autoComplete="nickname" autoCapitalize="words" spellCheck={false} required
            aria-invalid={nicknameProblem ? true : undefined} aria-describedby={nicknameProblem ? "settings-nickname-help settings-nickname-error" : "settings-nickname-help"}
            onChange={(e) => { setNickname(e.target.value); setNicknameProblem(null); }} />
          <small id="settings-nickname-help">{n.help}</small>
          {nicknameProblem && <small id="settings-nickname-error" className="bw-field-error">{n.errors[nicknameProblem]}</small>}
        </label>
        <button type="button" className="bw-button bw-button-outline" disabled={normalizeNickname(nickname) === normalizeNickname(account?.nickname) && nickname.trim() !== ""} onClick={saveNickname}>{x.save}</button>
        <label className="bw-field"><span>{x.language}</span>
          <LanguageSelect id="settings-language" onChange={(next) => save({ locale: next })} />
        </label>
      </div>
      <p role="status" aria-live="polite" className="bw-sr-status">{othersStatus ?? (accountStatus && x[accountStatus])}</p>
      <p className="bw-caption">{x.accountOnline}</p>
      <div className="bw-account-actions">
        <button type="button" className="bw-link-button" onClick={() => openExternal(websiteUrl("/app/settings", locale))}>{x.manageOnline} ↗</button>
        <button type="button" className="bw-button bw-button-outline" onClick={() => signOut()}>{x.signOut}</button>
        <button type="button" className="bw-link-button" onClick={() => { setOthersStatus(null); setAskOthers(true); }}>{x.signOutOthers}</button>
      </div>
      {askOthers && (
        <InlineDialog className="bw-confirm" role="alertdialog" label={x.othersQuestion} onCancel={() => setAskOthers(false)}>
          <p>{x.othersQuestion}</p>
          <button type="button" className="bw-button bw-button-outline" onClick={() => void endOtherSessions()}>{x.signOutOthers}</button>
          <button type="button" className="bw-link-button" onClick={() => setAskOthers(false)}>{m.ledger.common.cancel}</button>
        </InlineDialog>
      )}
    </section>
  );
}

export function AppearanceSection() {
  const { m } = useI18n();
  const [theme, setThemeState] = useState<ThemeChoice>(savedTheme);
  const x = m.settings;
  return (
    <section className="bw-panel" aria-labelledby="appearance-heading">
      <h2 id="appearance-heading">{x.appearance}</h2>
      <div className="bw-segmented" role="radiogroup" aria-label={x.theme} onKeyDown={radioGroupKeys}>
        {(["system", "light", "dark"] as const).map((choice) => (
          <button key={choice} type="button" role="radio" aria-checked={theme === choice} className={theme === choice ? "is-active" : ""}
            onClick={() => { setTheme(choice); setThemeState(choice); }}>
            {choice === "system" ? x.themeSystem : choice === "light" ? x.themeLight : x.themeDark}
          </button>
        ))}
      </div>
      <p className="bw-caption bw-section-gap">{x.themeHelp}</p>
    </section>
  );
}

export function RulesSection({ shell }: SectionProps) {
  const { m } = useI18n();
  const { store, refresh, rules } = useFinance();
  const x = m.settings;
  return (
    <section className="bw-panel" aria-labelledby="rules-heading" id="settings-rules">
      <h2 id="rules-heading">{x.rulesTitle}</h2>
      <p className="bw-caption">{m.settingsHub.rules.intro}</p>
      {(rules ?? []).length === 0 ? <p className="bw-muted">{x.rulesEmpty}</p> : (
        <ul className="bw-simple-list">
          {rules.map((rule) => (
            <li key={`${rule.merchantKey}-${rule.income}`}>
              <strong>{rule.merchantKey}</strong>
              <small>{rule.income ? x.moneyIn : x.moneyOut} → {categoryLabel(m, rule.category)}</small>
              <button className="bw-link-button" onClick={async () => { await store.deleteRule(rule); await refresh(); }}>{x.forget}</button>
            </li>
          ))}
        </ul>
      )}
      {shell && <div className="bw-db-actions"><button type="button" className="bw-button bw-button-outline" onClick={() => shell.go("categories")}>{m.settingsHub.rules.categories}</button></div>}
    </section>
  );
}

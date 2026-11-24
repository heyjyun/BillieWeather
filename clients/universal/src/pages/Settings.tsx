import { useState } from "react";
import { PageHeading } from "../components/common";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, LanguageSelect, useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { NICKNAME_MAX, normalizeNickname, validateNickname, type NicknameProblem } from "../services/profile";
import { regionLabel } from "../services/regions";
import { openExternal } from "../services/session";
import { savedTheme, setTheme, type ThemeChoice } from "../services/theme";
import { useModules } from "../hooks/useModules";

function regionName(code: string | null | undefined, locale: string, globalCitizen: string): string {
  if (!code) return "—";
  if (code === "XG") return globalCitizen;
  return regionLabel(code, locale);
}

export function Settings({ openLibrary, openData }: { openLibrary?: () => void; openData?: () => void } = {}) {
  const { m, locale } = useI18n();
  const { account, offline, signOut, savePreferences } = useAccount();
  const { store, refresh, rules } = useFinance();
  const [nickname, setNickname] = useState(account?.nickname ?? "");
  const [accountStatus, setAccountStatus] = useState<"saved" | "saveFailed" | null>(null);
  const [theme, setThemeState] = useState<ThemeChoice>(savedTheme);
  const x = m.settings;
  const n = m.personal.nickname;
  const [nicknameProblem, setNicknameProblem] = useState<NicknameProblem | null>(null);
  const { enabledList } = useModules();

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
    try {
      await savePreferences(preferences);
      setAccountStatus("saved");
    } catch {
      setAccountStatus("saveFailed");
    }
  }


  const memberSince = account?.registeredAt ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(account.registeredAt)) : "—";

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      {(openLibrary || openData) && (
        <section className="bw-panel" id="settings-feature-library" aria-labelledby="settings-library-heading">
          <h2 id="settings-library-heading">{m.modules.library.title}</h2>
          <p className="bw-muted">{m.modules.library.intro}</p>
          <p className="bw-caption">{enabledList.map((module) => m.modules.names[module.id]).join(" · ")}</p>
          <div className="bw-db-actions">
            {openLibrary && <button type="button" className="bw-button bw-button-dark" onClick={openLibrary}>{m.modules.library.open}</button>}
            {openData && <button type="button" className="bw-button bw-button-outline" onClick={openData}>{m.modules.library.dataLink}</button>}
          </div>
        </section>
      )}
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
        <p role="status" aria-live="polite" className="bw-sr-status">{accountStatus && x[accountStatus]}</p>
        <p className="bw-caption">{x.accountOnline}</p>
        <div className="bw-account-actions">
          <button type="button" className="bw-link-button" onClick={() => openExternal(websiteUrl("/app/settings", locale))}>{x.manageOnline} ↗</button>
          <button type="button" className="bw-button bw-button-outline" onClick={() => signOut()}>{x.signOut}</button>
        </div>
      </section>

      <section className="bw-panel" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">{x.appearance}</h2>
        <div className="bw-segmented" role="radiogroup" aria-label={x.theme}>
          {(["system", "light", "dark"] as const).map((choice) => (
            <button key={choice} type="button" role="radio" aria-checked={theme === choice} className={theme === choice ? "is-active" : ""}
              onClick={() => { setTheme(choice); setThemeState(choice); }}>
              {choice === "system" ? x.themeSystem : choice === "light" ? x.themeLight : x.themeDark}
            </button>
          ))}
        </div>
        <p className="bw-caption bw-section-gap">{x.themeHelp}</p>
      </section>

      <section className="bw-panel">
        <h2>{x.rulesTitle}</h2>
        {rules.length === 0 ? <p className="bw-muted">{x.rulesEmpty}</p> : (
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
      </section>

    </>
  );
}

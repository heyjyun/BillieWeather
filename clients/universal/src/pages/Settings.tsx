import { useState } from "react";
import { PageHeading } from "../components/common";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, LanguageSelect, useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { openExternal } from "../services/session";

function regionName(code: string | null | undefined, locale: string, globalCitizen: string): string {
  if (!code) return "—";
  if (code === "XG") return globalCitizen;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function Settings() {
  const { m, locale } = useI18n();
  const { account, offline, signOut, savePreferences } = useAccount();
  const { store, refresh, rules } = useFinance();
  const [nickname, setNickname] = useState(account?.nickname ?? "");
  const [accountStatus, setAccountStatus] = useState("");
  const x = m.settings;

  async function save(preferences: Parameters<typeof savePreferences>[0]) {
    try {
      await savePreferences(preferences);
      setAccountStatus(x.saved);
    } catch {
      setAccountStatus(x.saveFailed);
    }
  }


  const memberSince = account?.registeredAt ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(account.registeredAt)) : "—";

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <section className="bw-panel bw-account" aria-labelledby="account-heading">
        <h2 id="account-heading">{x.account}</h2>
        {offline && <p className="bw-message bw-message-warn">{x.offlineAccount}</p>}
        <dl className="bw-account-facts">
          <div><dt>{x.email}</dt><dd>{account?.email}</dd></div>
          <div><dt>{x.memberSince}</dt><dd>{memberSince}</dd></div>
          <div><dt>{x.region}</dt><dd>{regionName(account?.usageRegion, locale, x.globalCitizen)}</dd></div>
        </dl>
        <div className="bw-account-form">
          <label className="bw-field"><span>{x.nickname}</span>
            <input value={nickname} maxLength={40} placeholder={x.nicknamePlaceholder} onChange={(e) => setNickname(e.target.value)} />
          </label>
          <button type="button" className="bw-button bw-button-outline" disabled={nickname.trim() === (account?.nickname ?? "")} onClick={() => save({ nickname: nickname.trim() })}>{x.save}</button>
          <label className="bw-field"><span>{x.language}</span>
            <LanguageSelect id="settings-language" onChange={(next) => save({ locale: next })} />
          </label>
        </div>
        <p role="status" aria-live="polite" className="bw-sr-status">{accountStatus}</p>
        <p className="bw-caption">{x.accountOnline}</p>
        <div className="bw-account-actions">
          <button type="button" className="bw-link-button" onClick={() => openExternal(websiteUrl("/app/settings", locale))}>{x.manageOnline} ↗</button>
          <button type="button" className="bw-button bw-button-outline" onClick={() => signOut()}>{x.signOut}</button>
        </div>
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

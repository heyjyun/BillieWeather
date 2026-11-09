import { useState } from "react";
import { PageHeading } from "../components/common";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { LanguageSelect, useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { openExternal } from "../services/session";

export function Settings() {
  const { m, t, locale } = useI18n();
  const { account, offline, signOut, savePreferences } = useAccount();
  const { store, refresh, rules, statements, transactions, persistent, sync, syncEnabled, lastChecked, syncNow, setSyncEnabled, reporting } = useFinance();
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
          <div><dt>{x.region}</dt><dd>{account?.usageRegion ?? "—"}</dd></div>
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

      {persistent && (
        <section className="bw-panel bw-report" aria-labelledby="report-heading">
          <h2 id="report-heading">{m.report.title}</h2>
          <p>{m.report.body}</p>
          <label className="bw-check"><input type="checkbox" checked={reporting.enabled} onChange={(e) => void reporting.setEnabled(e.target.checked)} /> {m.report.title}</label>
          {reporting.pendingRemoval && <p className="bw-caption" role="status">{m.report.pending}</p>}
          {!reporting.enabled && !reporting.pendingRemoval && reporting.removalConfirmed && <p className="bw-caption" role="status">{m.report.removed}</p>}
        </section>
      )}

      <section className="bw-panel bw-web-sync" aria-labelledby="web-sync-heading">
        <h2 id="web-sync-heading">{m.sync.title}</h2>
        <p>{m.sync.body}</p>
        <label className="bw-check"><input type="checkbox" checked={syncEnabled} onChange={(e) => setSyncEnabled(e.target.checked)} /> {m.sync.toggle}</label>
        <p className="bw-caption">{m.sync.rules}</p>
        <div className="bw-account-actions">
          <span className="bw-caption">{lastChecked ? t("sync.lastChecked", { time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(lastChecked)) }) : m.sync.never}</span>
          <button type="button" className="bw-button bw-button-outline" disabled={!syncEnabled || sync.status === "checking"} onClick={() => syncNow(true)}>{sync.status === "checking" ? m.sync.checking : m.sync.checkNow}</button>
        </div>
      </section>

      <section className="bw-panel">
        <h2>{x.whereTitle}</h2>
        <p>{persistent ? x.whereBody : x.wherePreview}</p>
        <ul className="bw-privacy-list">
          <li>{x.privacy1}</li>
          <li>{x.privacy2}</li>
          <li>{x.privacy3}</li>
          <li>{x.privacy4}</li>
        </ul>
        <p className="bw-caption">{x.encryption}</p>
        <p className="bw-caption">{t("settings.counts", { statements: statements.length, transactions: transactions.length, rules: rules.length })}</p>
      </section>

      <section className="bw-panel">
        <h2>{x.rulesTitle}</h2>
        {rules.length === 0 ? <p className="bw-muted">{x.rulesEmpty}</p> : (
          <ul className="bw-simple-list">
            {rules.map((rule) => (
              <li key={`${rule.merchantKey}-${rule.income}`}>
                <strong>{rule.merchantKey}</strong>
                <small>{rule.income ? x.moneyIn : x.moneyOut} → {m.categories[rule.category]}</small>
                <button className="bw-link-button" onClick={async () => { await store.deleteRule(rule); await refresh(); }}>{x.forget}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

    </>
  );
}

// A gentle, dismissible suggestion for accounts created before nicknames were required.
// It never blocks anything: "Maybe later" hides it on this device for a while. Saving sends only
// the nickname to the BillieWeather account (useAccount().savePreferences) — no financial data.
import { icons } from "@billie/design-tokens";
import { useId, useState, type FormEvent } from "react";
import { useAccount } from "../hooks/useAccount";
import { usePersonal } from "../hooks/usePersonal";
import { interpolate } from "../i18n";
import { NICKNAME_MAX, normalizeNickname, validateNickname, type NicknameProblem } from "../services/profile";

const PREFIX = "billie.nicknamePrompt.";
export const SNOOZE_DAYS = 14;

export function isPromptSnoozed(ownerKey: string, now: Date = new Date()): boolean {
  try {
    const until = Number(localStorage.getItem(PREFIX + ownerKey));
    return Number.isFinite(until) && until > now.getTime();
  } catch {
    return false;
  }
}

export function snoozePrompt(ownerKey: string, now: Date = new Date()): void {
  try {
    localStorage.setItem(PREFIX + ownerKey, String(now.getTime() + SNOOZE_DAYS * 86_400_000));
  } catch {
    // storage unavailable: the suggestion may show again next time, which is harmless
  }
}

export function NicknamePrompt({ ownerKey }: { ownerKey: string | null }) {
  const { account, savePreferences } = useAccount();
  const { p } = usePersonal();
  const id = useId();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<NicknameProblem | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => !ownerKey || isPromptSnoozed(ownerKey));
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const x = p.nickname_prompt;

  if (savedAs) return <p className="bw-success-line" role="status">{interpolate(x.saved, { name: savedAs })}</p>;
  if (!account || account.nickname?.trim() || hidden) return null;

  async function save(event: FormEvent) {
    event.preventDefault();
    const issue = validateNickname(value);
    setProblem(issue);
    setFailed(false);
    if (issue) return;
    const nickname = normalizeNickname(value)!;
    setBusy(true);
    try {
      await savePreferences({ nickname });
      setSavedAs(nickname);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const describedBy = [`${id}-help`, problem ? `${id}-error` : "", failed ? `${id}-failed` : ""].filter(Boolean).join(" ");
  return (
    <section className="bw-nickname-prompt" aria-labelledby={`${id}-title`}>
      <span className="bw-nickname-prompt-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icons.sun} /></svg>
      </span>
      <div className="bw-nickname-prompt-body">
        <h2 id={`${id}-title`}>{x.title}</h2>
        <p>{x.body}</p>
        <form className="bw-nickname-prompt-form" onSubmit={(event) => void save(event)} noValidate>
          <label className="bw-field">
            <span>{p.nickname.label}<span className="bw-required-mark" aria-hidden="true">*</span><span className="bw-visually-hidden"> ({p.nickname.required})</span></span>
            <input value={value} onChange={(event) => setValue(event.target.value)} maxLength={NICKNAME_MAX} autoComplete="nickname" autoCapitalize="words" spellCheck={false}
              placeholder={p.nickname.placeholder} required disabled={busy} aria-invalid={problem ? true : undefined} aria-describedby={describedBy} />
            <small id={`${id}-help`}>{p.nickname.help}</small>
            {problem && <small id={`${id}-error`} className="bw-field-error">{p.nickname.errors[problem]}</small>}
          </label>
          <div className="bw-nickname-prompt-actions">
            <button type="submit" className="bw-button bw-button-dark" disabled={busy}>{busy ? x.saving : x.save}</button>
            <button type="button" className="bw-link-button" disabled={busy} onClick={() => { if (ownerKey) snoozePrompt(ownerKey); setHidden(true); }}>{x.later}</button>
          </div>
          {failed && <p id={`${id}-failed`} className="bw-message bw-message-error" role="alert">{x.failed}</p>}
        </form>
      </div>
    </section>
  );
}

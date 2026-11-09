import { useState, type FormEvent } from "react";
import { LanguageSelect, useI18n } from "../i18n";
import { useAccount } from "../hooks/useAccount";
import { AccountError, websiteUrl } from "../services/account";
import { openExternal } from "../services/session";

export function Login() {
  const { m, locale } = useI18n();
  const { signIn } = useAccount();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needsOtp, setNeedsOtp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password, needsOtp ? otp.trim() : undefined);
    } catch (caught) {
      const code = caught instanceof AccountError ? caught.code : "unknown";
      if (code === "otp_required") setNeedsOtp(true);
      const messages = m.login.errors as Record<string, string>;
      setError(messages[code] ?? m.login.errors.unknown);
      setPassword(code === "otp_required" || code === "invalid_otp" ? password : "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bw-login">
      <div className="bw-login-card">
        <div className="bw-login-top">
          <div className="bw-brand"><span className="bw-brand-mark">b<small>·</small></span><span>BillieWeather</span></div>
          <label className="bw-login-language"><span className="bw-visually-hidden">{m.login.language}</span><LanguageSelect id="login-language" /></label>
        </div>
        <span className="bw-eyebrow">{m.login.tagline}</span>
        <h1>{m.login.heading}</h1>
        <p className="bw-muted">{m.login.intro}</p>
        <form onSubmit={submit} className="bw-login-form" noValidate>
          <label className="bw-field"><span>{m.login.email}</span>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          </label>
          <label className="bw-field"><span>{m.login.password}</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </label>
          {needsOtp && (
            <label className="bw-field"><span>{m.login.otp}</span>
              <input inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} disabled={busy} autoFocus />
              <small>{m.login.otpHelp}</small>
            </label>
          )}
          {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
          <button type="submit" className="bw-button bw-button-dark" disabled={busy || !email || !password}>{busy ? m.login.submitting : m.login.submit}</button>
        </form>
        <div className="bw-login-links">
          <button type="button" className="bw-link-button" onClick={() => openExternal(websiteUrl("/users/sign_up", locale))}>{m.login.createAccount}</button>
          <button type="button" className="bw-link-button" onClick={() => openExternal(websiteUrl("/users/password/new", locale))}>{m.login.forgot}</button>
        </div>
      </div>
      <p className="bw-login-footer">{m.footer}</p>
    </main>
  );
}

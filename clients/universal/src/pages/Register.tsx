// Create an account inside the app (macOS, Windows, iOS, Android: one implementation).
// Talks to the identity service (services/registration.ts) and then signs in through the existing
// account flow (useAccount().signIn), so the account-bound local database logic is unchanged:
// a new account gets its own owner key and never opens another account's financial data.
// Nothing financial is read or sent here.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BrandMark } from "../components/BrandMark";
import { useAccount } from "../hooks/useAccount";
import { interpolate, LanguageSelect, useI18n } from "../i18n";
import { GLOBAL_CITIZEN, matchesRegion, regionOptions, REGION_CODES } from "../services/regions";
import {
  cancelGoogle, completeGoogle, confirmRegistration, fetchIdentityConfig, googleStatus, IDENTITY_ORIGIN, linkGoogle, RegistrationError, resendCode,
  startGoogle, startRegistration, type GoogleFlow, type GoogleStatus, type PendingRegistration,
} from "../services/registration";
import { openExternal } from "../services/session";
import { NICKNAME_MAX, normalizeNickname, validateNickname } from "../services/profile";
import "./Register.css";

export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;
const RESEND_SECONDS = 60;
const POLL_MS = 2000;
// The same rule as Devise (config.email_regexp); the server re-checks everything.
const EMAIL = /^[^@ \t\r\n\f\v]+@[^@ \t\r\n\f\v]+$/;

export type FieldErrors = Record<string, string[]>;

export interface SignUpValues { nickname: string; region: string; email: string; password: string; confirmation: string }

/** Client-side checks mirroring the server, so most mistakes are caught before anything is sent. */
export function validateSignUp(values: SignUpValues, { email = true }: { email?: boolean } = {}): FieldErrors {
  const errors: FieldErrors = {};
  if (email) {
    const address = values.email.trim();
    if (!address) errors.email = ["blank"];
    else if (address.length > 254 || !EMAIL.test(address)) errors.email = ["invalid"];
  }
  if (!values.password) errors.password = ["blank"];
  else if (values.password.length < PASSWORD_MIN) errors.password = ["too_short"];
  else if (values.password.length > PASSWORD_MAX) errors.password = ["too_long"];
  if (values.confirmation !== values.password) errors.password_confirmation = ["mismatch"];
  if (!values.region) errors.usage_region = ["blank"];
  else if (values.region !== GLOBAL_CITIZEN && !REGION_CODES.includes(values.region)) errors.usage_region = ["inclusion"];
  // Required for every new account (email and Google alike); any language, not unique.
  const nickname = validateNickname(values.nickname);
  if (nickname) errors.nickname = [nickname];
  return errors;
}

type Step =
  | { kind: "form" }
  | { kind: "verify"; pending: PendingRegistration }
  | { kind: "google-wait"; flow: GoogleFlow }
  | { kind: "google-new"; flow: GoogleFlow; email: string }
  | { kind: "google-link"; flow: GoogleFlow; email: string }
  | { kind: "google-info"; email: string; message: string }
  | { kind: "signing-in"; email: string }
  | { kind: "created"; email: string };

const FIELD_ORDER = ["nickname", "usage_region", "email", "password", "password_confirmation", "code"];

export function Register({ onBack }: { onBack: (email?: string) => void }) {
  const { m, locale } = useI18n();
  const r = m.register;
  const { signIn } = useAccount();
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [values, setValues] = useState<SignUpValues>({ nickname: "", region: GLOBAL_CITIZEN, email: "", password: "", confirmation: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  const [closed, setClosed] = useState(false);
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const firstRender = useRef(true);

  const set = (name: keyof SignUpValues) => (value: string) => setValues((current) => ({ ...current, [name]: value }));

  // Whether the account service answers. When it doesn't, say why (and offer a retry) before the
  // person fills in the form; the form still works and re-checks on submit.
  const [service, setService] = useState<"checking" | "ready" | RegistrationError>("checking");
  const checkService = useCallback(() => {
    let cancelled = false;
    setService("checking");
    fetchIdentityConfig().then((config) => {
      if (cancelled) return;
      setGoogle(config.googleAvailable);
      setClosed(!config.registrationOpen);
      setService("ready");
    }).catch((caught: unknown) => {
      if (!cancelled) setService(caught instanceof RegistrationError ? caught : new RegistrationError("unknown"));
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => checkService(), [checkService]);

  // Move focus to the new screen's heading, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    heading.current?.focus();
  }, [step.kind]);

  useEffect(() => {
    if (step.kind !== "verify") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step.kind]);

  const errorText = useCallback((caught: unknown): string => {
    const failure = caught instanceof RegistrationError ? caught : new RegistrationError("unknown");
    const table = r.errors as Record<string, string>;
    const text = table[failure.code] ?? r.errors.unknown;
    return interpolate(text, { remaining: failure.attemptsRemaining ?? 0, seconds: failure.retryAfter ?? RESEND_SECONDS, host: new URL(IDENTITY_ORIGIN).host });
  }, [r]);

  const fieldText = (field: string, problem: string) => {
    if (field === "nickname") return (m.personal.nickname.errors as Record<string, string>)[problem] ?? r.fix;
    const table = r.fields as Record<string, string>;
    return interpolate(table[`${field}_${problem}`] ?? r.fix, { min: PASSWORD_MIN, max: PASSWORD_MAX });
  };

  /** Shows field errors and moves focus to the first one. */
  const showFields = (errors: FieldErrors) => {
    setFieldErrors(errors);
    const first = FIELD_ORDER.find((field) => errors[field]?.length);
    if (first) {
      setError(r.fix);
      setTimeout(() => formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus(), 0);
    }
  };

  const handleFailure = (caught: unknown) => {
    if (caught instanceof RegistrationError && caught.code === "invalid" && Object.keys(caught.fields).length) {
      showFields(caught.fields);
      return;
    }
    setError(errorText(caught));
  };

  const reset = () => { setError(null); setNotice(null); setFieldErrors({}); };

  /** The account exists: sign in through the existing account flow (Rails session token). */
  const finish = async (email: string, password: string) => {
    setStep({ kind: "signing-in", email });
    try {
      await signIn(email, password);
      // Signed in: the app replaces this screen. The password is dropped with this component.
    } catch {
      setValues((current) => ({ ...current, password: "", confirmation: "" }));
      setStep({ kind: "created", email });
    }
  };

  // --- email + password ------------------------------------------------------------------------

  async function submitForm(event: FormEvent) {
    event.preventDefault();
    reset();
    const errors = validateSignUp(values);
    if (Object.keys(errors).length) return showFields(errors);
    setBusy(true);
    try {
      const pending = await startRegistration({
        email: values.email.trim(), password: values.password, passwordConfirmation: values.confirmation,
        usageRegion: values.region, nickname: normalizeNickname(values.nickname) ?? "", locale,
      });
      setCode("");
      setResendAt(Date.now() + RESEND_SECONDS * 1000);
      setStep({ kind: "verify", pending });
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent, pending: PendingRegistration) {
    event.preventDefault();
    reset();
    const digits = code.replace(/[\s-]/g, "");
    if (!/^\d+$/.test(digits) || digits.length !== pending.codeLength) return showFields({ code: ["invalid"] });
    setBusy(true);
    try {
      const confirmed = await confirmRegistration(pending, digits);
      await finish(confirmed.email, values.password);
    } catch (caught) {
      if (caught instanceof RegistrationError && caught.code === "email_taken") {
        setStep({ kind: "form" });
        setError(errorText(caught));
      } else {
        handleFailure(caught);
      }
    } finally {
      setBusy(false);
    }
  }

  async function resend(pending: PendingRegistration) {
    reset();
    setBusy(true);
    try {
      await resendCode(pending);
      setResendAt(Date.now() + RESEND_SECONDS * 1000);
      setNotice(r.verify.resent);
    } catch (caught) {
      if (caught instanceof RegistrationError && caught.code === "resend_too_soon" && caught.retryAfter) setResendAt(Date.now() + caught.retryAfter * 1000);
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  // --- Google ----------------------------------------------------------------------------------

  async function beginGoogle() {
    reset();
    setBusy(true);
    try {
      const flow = await startGoogle(locale);
      await openExternal(flow.authorizationUrl);
      setStep({ kind: "google-wait", flow });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const backToForm = (message: string | null) => {
    setStep({ kind: "form" });
    setFieldErrors({});
    setNotice(null);
    setError(message);
  };

  const onGoogleStatus = useCallback((flow: GoogleFlow, status: GoogleStatus): boolean => {
    const g = r.googleFlow as Record<string, string>;
    if (status.status === "started") return false;
    if (status.status === "verified" && status.email) {
      if (status.outcome === "new_account") setStep({ kind: "google-new", flow, email: status.email });
      else if (status.outcome === "link_required") setStep({ kind: "google-link", flow, email: status.email });
      else if (status.outcome === "already_linked") setStep({ kind: "google-info", email: status.email, message: interpolate(r.googleFlow.existing, { email: status.email }) });
      else setStep({ kind: "google-info", email: status.email, message: g[status.failure ?? ""] ?? r.googleFlow.account_unavailable });
      return true;
    }
    if (status.status === "cancelled") backToForm(r.googleFlow.cancelled);
    else if (status.status === "expired") backToForm(r.googleFlow.expired);
    else backToForm(r.googleFlow.failed);
    return true;
  }, [r]);

  useEffect(() => {
    if (step.kind !== "google-wait") return;
    const { flow } = step;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const status = await googleStatus(flow);
        if (!stopped && onGoogleStatus(flow, status)) stopped = true;
      } catch (caught) {
        // Offline for a moment: keep waiting. A flow the server no longer knows has ended.
        if (!stopped && caught instanceof RegistrationError && caught.code === "not_found") { stopped = true; backToForm(r.googleFlow.expired); }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(poll, POLL_MS);
    window.addEventListener("focus", poll);
    void poll();
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [step, onGoogleStatus, r]);

  async function cancelGoogleFlow(flow: GoogleFlow) {
    await cancelGoogle(flow);
    backToForm(r.googleFlow.cancelled);
  }

  async function submitGoogleNew(event: FormEvent, flow: GoogleFlow, email: string) {
    event.preventDefault();
    reset();
    const errors = validateSignUp(values, { email: false });
    if (Object.keys(errors).length) return showFields(errors);
    setBusy(true);
    try {
      await completeGoogle(flow, { password: values.password, passwordConfirmation: values.confirmation, usageRegion: values.region, nickname: normalizeNickname(values.nickname) ?? "" });
      await finish(email, values.password);
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  async function submitGoogleLink(event: FormEvent, flow: GoogleFlow, email: string) {
    event.preventDefault();
    reset();
    if (!values.password) return showFields({ password: ["blank"] });
    setBusy(true);
    try {
      await linkGoogle(flow, values.password);
      await finish(email, values.password);
    } catch (caught) {
      setValues((current) => ({ ...current, password: "" }));
      handleFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  // --- rendering -------------------------------------------------------------------------------

  const messages = (
    <>
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      {notice && <p className="bw-message bw-message-ok" role="status">{notice}</p>}
    </>
  );
  const fieldProps = (field: string) => ({ field, errors: (fieldErrors[field] ?? []).map((problem) => fieldText(field, problem)) });
  const backButton = (
    <button type="button" className="bw-link-button bw-register-back" onClick={() => {
      if (step.kind === "google-wait") void cancelGoogle(step.flow);
      onBack(step.kind === "created" || step.kind === "google-info" ? step.email : undefined);
    }}>
      <span aria-hidden="true">←</span> {r.back}
    </button>
  );

  let body: ReactNode;
  if (step.kind === "form") {
    body = (
      <>
        <span className="bw-eyebrow">{r.eyebrow}</span>
        <h1 ref={heading} tabIndex={-1}>{r.heading}</h1>
        <p className="bw-muted">{r.intro}</p>
        {google && (
          <div className="bw-register-google">
            <button type="button" className="bw-button bw-button-outline bw-google-button" disabled={busy || closed} onClick={() => void beginGoogle()} aria-describedby="register-google-help">
              <GoogleMark /> {r.googleButton}
            </button>
            <small id="register-google-help" className="bw-muted">{r.googleHelp}</small>
            <p className="bw-register-divider"><span>{r.or}</span></p>
          </div>
        )}
        <form ref={formRef} onSubmit={submitForm} className="bw-login-form" noValidate aria-describedby="register-privacy">
          {messages}
          {closed && <p className="bw-message bw-message-warn" role="status">{r.errors.registration_closed}</p>}
          {service instanceof RegistrationError && !error && (
            <p className="bw-message bw-message-warn" role="status">
              {errorText(service)}{" "}
              <button type="button" className="bw-link-button" onClick={() => { checkService(); }}>{r.retry}</button>
            </p>
          )}
          <NicknameField value={values.nickname} onChange={set("nickname")} disabled={busy} {...fieldProps("nickname")} />
          <RegionField value={values.region} onChange={set("region")} disabled={busy} {...fieldProps("usage_region")} />
          <TextField label={r.email} type="email" value={values.email} onChange={set("email")} autoComplete="email" inputMode="email" required disabled={busy} {...fieldProps("email")} />
          <PasswordField label={r.password} help={interpolate(r.passwordHelp, { min: PASSWORD_MIN })} value={values.password} onChange={set("password")} autoComplete="new-password" disabled={busy} {...fieldProps("password")} />
          <PasswordField label={r.confirmPassword} value={values.confirmation} onChange={set("confirmation")} autoComplete="new-password" disabled={busy} {...fieldProps("password_confirmation")} />
          <button type="submit" className="bw-button bw-button-dark" disabled={busy || closed}>{busy ? r.submitting : r.submit}</button>
        </form>
        <p className="bw-muted bw-register-privacy" id="register-privacy">{r.privacy}</p>
        <p className="bw-register-switch">{r.haveAccount} <button type="button" className="bw-link-button" onClick={() => onBack(values.email.trim() || undefined)}>{r.signIn}</button></p>
      </>
    );
  } else if (step.kind === "verify") {
    const { pending } = step;
    const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>{r.verify.heading}</h1>
        <p className="bw-muted">{interpolate(r.verify.intro, { email: pending.email, length: pending.codeLength })}</p>
        <form ref={formRef} onSubmit={(event) => void submitCode(event, pending)} className="bw-login-form" noValidate>
          {messages}
          <TextField label={r.verify.code} help={r.verify.codeHelp} value={code} onChange={setCode} autoComplete="one-time-code" inputMode="numeric"
            maxLength={pending.codeLength + 1} className="bw-code-input" disabled={busy} autoFocus {...fieldProps("code")} />
          <button type="submit" className="bw-button bw-button-dark" disabled={busy || code.replace(/[\s-]/g, "").length === 0}>{busy ? r.verify.submitting : r.verify.submit}</button>
        </form>
        <p className="bw-muted bw-register-note">{r.verify.notice}</p>
        <div className="bw-register-actions">
          <button type="button" className="bw-link-button" disabled={busy || wait > 0} onClick={() => void resend(pending)}>
            {wait > 0 ? interpolate(r.verify.resendIn, { seconds: wait }) : r.verify.resend}
          </button>
          <button type="button" className="bw-link-button" disabled={busy} onClick={() => { reset(); setValues((current) => ({ ...current, password: "", confirmation: "" })); setStep({ kind: "form" }); }}>{r.verify.changeEmail}</button>
        </div>
      </>
    );
  } else if (step.kind === "google-wait") {
    const { flow } = step;
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>{r.googleFlow.waiting}</h1>
        <p className="bw-muted">{r.googleFlow.waitingIntro}</p>
        <p className="bw-register-progress" role="status"><span className="bw-spinner" aria-hidden="true" /> {r.googleFlow.waiting}</p>
        {messages}
        <div className="bw-register-actions">
          <button type="button" className="bw-button bw-button-outline" onClick={() => void openExternal(flow.authorizationUrl)}>{r.googleFlow.reopen}</button>
          <button type="button" className="bw-link-button" onClick={() => void cancelGoogleFlow(flow)}>{r.googleFlow.cancel}</button>
        </div>
      </>
    );
  } else if (step.kind === "google-new") {
    const { flow, email } = step;
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>{r.googleFlow.newHeading}</h1>
        <p className="bw-muted">{interpolate(r.googleFlow.newIntro, { email })}</p>
        <form ref={formRef} onSubmit={(event) => void submitGoogleNew(event, flow, email)} className="bw-login-form" noValidate>
          {messages}
          <NicknameField value={values.nickname} onChange={set("nickname")} disabled={busy} {...fieldProps("nickname")} />
          <RegionField value={values.region} onChange={set("region")} disabled={busy} {...fieldProps("usage_region")} />
          <input type="email" value={email} autoComplete="username" readOnly hidden />
          <PasswordField label={r.password} help={interpolate(r.passwordHelp, { min: PASSWORD_MIN })} value={values.password} onChange={set("password")} autoComplete="new-password" disabled={busy} {...fieldProps("password")} />
          <PasswordField label={r.confirmPassword} value={values.confirmation} onChange={set("confirmation")} autoComplete="new-password" disabled={busy} {...fieldProps("password_confirmation")} />
          <small className="bw-muted">{r.googleFlow.newWhy}</small>
          <button type="submit" className="bw-button bw-button-dark" disabled={busy}>{busy ? r.googleFlow.creating : r.googleFlow.create}</button>
        </form>
      </>
    );
  } else if (step.kind === "google-link") {
    const { flow, email } = step;
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>{r.googleFlow.linkHeading}</h1>
        <p className="bw-muted">{interpolate(r.googleFlow.linkIntro, { email })}</p>
        <form ref={formRef} onSubmit={(event) => void submitGoogleLink(event, flow, email)} className="bw-login-form" noValidate>
          {messages}
          <input type="email" value={email} autoComplete="username" readOnly hidden />
          <PasswordField label={r.password} value={values.password} onChange={set("password")} autoComplete="current-password" disabled={busy} {...fieldProps("password")} />
          <button type="submit" className="bw-button bw-button-dark" disabled={busy || !values.password}>{busy ? r.googleFlow.linking : r.googleFlow.link}</button>
        </form>
      </>
    );
  } else if (step.kind === "google-info") {
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>{r.heading}</h1>
        <p className="bw-message bw-message-warn" role="status">{step.message}</p>
        <button type="button" className="bw-button bw-button-dark" onClick={() => onBack(step.email)}>{r.signIn}</button>
      </>
    );
  } else if (step.kind === "signing-in") {
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>{r.done.heading}</h1>
        <p className="bw-register-progress" role="status"><span className="bw-spinner" aria-hidden="true" /> {r.done.signingIn}</p>
      </>
    );
  } else {
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>{r.done.heading}</h1>
        <p className="bw-message bw-message-ok" role="status">{r.done.signInFailed}</p>
        <button type="button" className="bw-button bw-button-dark" onClick={() => onBack(step.email)}>{r.done.signIn}</button>
      </>
    );
  }

  return (
    <main className="bw-login bw-register">
      <div className="bw-login-card">
        <div className="bw-login-top">
          <div className="bw-brand"><BrandMark /><span>BillieWeather</span></div>
          <label className="bw-login-language"><span className="bw-visually-hidden">{m.login.language}</span><LanguageSelect id="register-language" /></label>
        </div>
        {step.kind !== "signing-in" && backButton}
        {body}
      </div>
      <p className="bw-login-footer">{m.footer}</p>
    </main>
  );
}

// --- fields ------------------------------------------------------------------------------------

interface FieldBase { label: string; value: string; onChange: (value: string) => void; field: string; errors: string[]; help?: string; disabled?: boolean }

function describedBy(id: string, help?: string, errors: string[] = []) {
  return [help ? `${id}-help` : "", errors.length ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
}

function FieldMessages({ id, help, errors }: { id: string; help?: string; errors: string[] }) {
  return (
    <>
      {help && <small id={`${id}-help`}>{help}</small>}
      {errors.length > 0 && <small id={`${id}-error`} className="bw-field-error">{errors.join(" ")}</small>}
    </>
  );
}

function TextField({ label, value, onChange, field, errors, help, disabled, type = "text", autoComplete, inputMode, maxLength, required, requiredLabel, placeholder, autoCapitalize = "none", className, autoFocus }: FieldBase & {
  type?: string; autoComplete?: string; inputMode?: "email" | "numeric" | "text"; maxLength?: number; required?: boolean; className?: string; autoFocus?: boolean;
  /** Shows a visual required marker, announced to screen readers as this text. */
  requiredLabel?: string; placeholder?: string; autoCapitalize?: "none" | "words";
}) {
  const id = useId();
  return (
    <div className="bw-field">
      <label htmlFor={id}>{label}{requiredLabel && <><span className="bw-required-mark" aria-hidden="true">*</span><span className="bw-visually-hidden"> ({requiredLabel})</span></>}</label>
      <input id={id} data-field={field} type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} inputMode={inputMode}
        maxLength={maxLength} required={required} disabled={disabled} className={className} autoFocus={autoFocus} spellCheck={false} autoCapitalize={autoCapitalize} placeholder={placeholder}
        aria-invalid={errors.length > 0 || undefined} aria-describedby={describedBy(id, help, errors)} />
      <FieldMessages id={id} help={help} errors={errors} />
    </div>
  );
}

/** The required nickname, with the same copy on every sign-up path. */
function NicknameField({ value, onChange, field, errors, disabled }: Omit<FieldBase, "label" | "help">) {
  const { m } = useI18n();
  const n = m.personal.nickname;
  return (
    <TextField label={n.label} requiredLabel={n.required} help={n.help} placeholder={n.placeholder} value={value} onChange={onChange} autoComplete="nickname"
      autoCapitalize="words" maxLength={NICKNAME_MAX} required disabled={disabled} field={field} errors={errors} />
  );
}

function PasswordField({ label, value, onChange, field, errors, help, disabled, autoComplete }: FieldBase & { autoComplete: string }) {
  const { m } = useI18n();
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="bw-field">
      <label htmlFor={id}>{label}</label>
      <div className="bw-password">
        <input id={id} data-field={field} type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete}
          maxLength={PASSWORD_MAX + 1} disabled={disabled} spellCheck={false} autoCapitalize="none" autoCorrect="off"
          aria-invalid={errors.length > 0 || undefined} aria-describedby={describedBy(id, help, errors)} />
        <button type="button" className="bw-password-toggle" aria-controls={id} aria-pressed={visible} aria-label={visible ? m.register.hide : m.register.show}
          title={visible ? m.register.hide : m.register.show} onClick={() => setVisible((shown) => !shown)} disabled={disabled}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{visible && <path d="M3 3l18 18" />}
          </svg>
        </button>
      </div>
      <FieldMessages id={id} help={help} errors={errors} />
    </div>
  );
}

function RegionField({ value, onChange, field, errors, disabled }: Omit<FieldBase, "label" | "help">) {
  const { m, locale } = useI18n();
  const r = m.register;
  const id = useId();
  const [query, setQuery] = useState("");
  const options = useMemo(() => regionOptions(locale, r.globalCitizen), [locale, r.globalCitizen]);
  const shown = useMemo(() => {
    const matching = options.filter((option) => matchesRegion(option, query));
    // Keep the current choice visible so the select never shows an option that isn't selected.
    return matching.some((option) => option.code === value) ? matching : [...options.filter((option) => option.code === value), ...matching];
  }, [options, query, value]);
  const none = query.trim() !== "" && !options.some((option) => matchesRegion(option, query));
  return (
    <div className="bw-field bw-region-field">
      <label htmlFor={id}>{r.region}</label>
      <input type="search" className="bw-region-search" value={query} onChange={(event) => {
        const next = event.target.value;
        setQuery(next);
        const matches = options.filter((option) => matchesRegion(option, next));
        if (next.trim() && matches.length === 1) onChange(matches[0].code);
      }} placeholder={r.regionSearchPlaceholder} aria-label={r.regionSearch} aria-controls={id} autoComplete="off" spellCheck={false} disabled={disabled} />
      <select id={id} data-field={field} value={value} onChange={(event) => onChange(event.target.value)} autoComplete="country" disabled={disabled}
        aria-invalid={errors.length > 0 || undefined} aria-describedby={describedBy(id, r.regionHelp, errors)}>
        {shown.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
      </select>
      {none && <small role="status">{r.regionNoMatch}</small>}
      <FieldMessages id={id} help={r.regionHelp} errors={errors} />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

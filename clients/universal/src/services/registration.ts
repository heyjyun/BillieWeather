// Creating an account in the app. Talks ONLY to the BillieWeather identity service
// (services/identity-api), never to the Rails website, and sends only sign-up details: email,
// password, nickname, region and language. It must never import financial code or data
// (enforced by test/privacy.test.ts). Signing in afterwards uses the existing account service.

const configured = (import.meta.env.VITE_BILLIE_IDENTITY_URL as string | undefined)?.trim();
/** Origin of the identity service, set at build time by scripts/tauri.mjs (BILLIE_IDENTITY_URL). */
export const IDENTITY_ORIGIN = new URL(configured || "http://localhost:8100").origin;
const API = `${IDENTITY_ORIGIN}/v1`;

export type RegistrationErrorCode =
  | "invalid" | "invalid_code" | "code_expired" | "registration_expired" | "too_many_attempts" | "email_taken"
  | "resend_too_soon" | "resend_limit" | "already_confirmed" | "rate_limited" | "registration_closed" | "mail_unavailable"
  | "google_unavailable" | "flow_not_ready" | "invalid_password" | "google_taken" | "otp_required" | "locked"
  | "google_other_account" | "account_unavailable" | "not_found" | "service_not_ready" | "offline" | "unknown";

const KNOWN: readonly RegistrationErrorCode[] = [
  "invalid", "invalid_code", "code_expired", "registration_expired", "too_many_attempts", "email_taken",
  "resend_too_soon", "resend_limit", "already_confirmed", "rate_limited", "registration_closed", "mail_unavailable",
  "google_unavailable", "flow_not_ready", "invalid_password", "google_taken", "otp_required", "locked",
  "google_other_account", "account_unavailable", "not_found", "service_not_ready",
];

export class RegistrationError extends Error {
  constructor(
    public code: RegistrationErrorCode,
    public fields: Record<string, string[]> = {},
    public retryAfter: number | null = null,
    public attemptsRemaining: number | null = null,
  ) {
    super(code);
    this.name = "RegistrationError";
  }
}

async function call<T>(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new RegistrationError("offline");
  }
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = KNOWN.find((known) => known === json.error) ?? "unknown";
    const fields = json.fields && typeof json.fields === "object" ? (json.fields as Record<string, string[]>) : {};
    const retry = typeof json.retry_after === "number" ? json.retry_after : Number(response.headers.get("Retry-After")) || null;
    const remaining = typeof json.attempts_remaining === "number" ? json.attempts_remaining : null;
    throw new RegistrationError(code, fields, retry, remaining);
  }
  return json as T;
}

export interface IdentityConfig { registrationOpen: boolean; googleAvailable: boolean; passwordMin: number; passwordMax: number }

export async function fetchIdentityConfig(): Promise<IdentityConfig> {
  const json = await call<{ registration_open: boolean; google_available: boolean; password: { min: number; max: number } }>("/config", "GET");
  return { registrationOpen: json.registration_open, googleAvailable: json.google_available, passwordMin: json.password.min, passwordMax: json.password.max };
}

// --- email + password ------------------------------------------------------------------------

export interface SignUpDetails { email: string; password: string; passwordConfirmation: string; usageRegion: string; nickname: string; locale: string }

/** Kept in memory only. The secret is useless without the emailed code, and the code without it. */
export interface PendingRegistration { id: string; secret: string; email: string; codeLength: number; codeExpiresAt: string; resendAvailableAt: string }

export async function startRegistration(details: SignUpDetails): Promise<PendingRegistration> {
  const json = await call<{ registration_id: string; registration_secret: string; email: string; code_length: number; code_expires_at: string; resend_available_at: string }>(
    "/registrations", "POST", {
      email: details.email, password: details.password, password_confirmation: details.passwordConfirmation,
      usage_region: details.usageRegion, nickname: details.nickname, locale: details.locale,
    });
  return { id: json.registration_id, secret: json.registration_secret, email: json.email, codeLength: json.code_length, codeExpiresAt: json.code_expires_at, resendAvailableAt: json.resend_available_at };
}

const segment = (id: string) => encodeURIComponent(id);

export async function confirmRegistration(pending: PendingRegistration, code: string): Promise<{ email: string }> {
  return call<{ email: string }>(`/registrations/${segment(pending.id)}/confirmation`, "POST", { registration_secret: pending.secret, code });
}

export async function resendCode(pending: PendingRegistration): Promise<{ resendAvailableAt: string; resendsRemaining: number }> {
  const json = await call<{ resend_available_at: string; resends_remaining: number }>(`/registrations/${segment(pending.id)}/resend`, "POST", { registration_secret: pending.secret });
  return { resendAvailableAt: json.resend_available_at, resendsRemaining: json.resends_remaining };
}

// --- Google (system browser + PKCE-style verifier held only by this app) ------------------------

export interface GoogleFlow { id: string; verifier: string; authorizationUrl: string }
export type GoogleOutcome = "new_account" | "link_required" | "already_linked" | "unavailable";
export interface GoogleStatus { status: "started" | "verified" | "cancelled" | "failed" | "completed" | "expired"; outcome?: GoogleOutcome; email?: string; failure?: string }

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startGoogle(locale: string): Promise<GoogleFlow> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const json = await call<{ flow_id: string; authorization_url: string }>("/google/flows", "POST", { code_challenge: challenge, code_challenge_method: "S256", locale });
  if (!json.authorization_url.startsWith("https://accounts.google.com/")) throw new RegistrationError("google_unavailable");
  return { id: json.flow_id, verifier, authorizationUrl: json.authorization_url };
}

export async function googleStatus(flow: GoogleFlow): Promise<GoogleStatus> {
  return call<GoogleStatus>(`/google/flows/${segment(flow.id)}/status`, "POST", { code_verifier: flow.verifier });
}

export async function completeGoogle(flow: GoogleFlow, details: Omit<SignUpDetails, "email" | "locale">): Promise<{ email: string }> {
  return call<{ email: string }>(`/google/flows/${segment(flow.id)}/complete`, "POST", {
    code_verifier: flow.verifier, password: details.password, password_confirmation: details.passwordConfirmation,
    usage_region: details.usageRegion, nickname: details.nickname,
  });
}

export async function linkGoogle(flow: GoogleFlow, password: string): Promise<{ email: string }> {
  return call<{ email: string }>(`/google/flows/${segment(flow.id)}/link`, "POST", { code_verifier: flow.verifier, password });
}

export async function cancelGoogle(flow: GoogleFlow): Promise<void> {
  await call<void>(`/google/flows/${segment(flow.id)}/cancel`, "POST", { code_verifier: flow.verifier }).catch(() => undefined);
}

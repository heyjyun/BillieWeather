// @vitest-environment jsdom
// The in-app Create Account screen: validation, email code, resend, Google (success, link,
// cancellation, failure), navigation, localization and accessibility. The identity service is
// faked at the fetch boundary; signing in afterwards goes through the existing useAccount().signIn.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { I18nProvider, LOCALES, MESSAGES, type Locale } from "../src/i18n";
import { GLOBAL_CITIZEN, REGION_CODES, regionOptions } from "../src/services/regions";
import { IDENTITY_ORIGIN } from "../src/services/registration";

const signIn = vi.fn();
vi.mock("../src/hooks/useAccount", () => ({ useAccount: () => ({ signIn }) }));
const openExternal = vi.fn(async (_url: string) => undefined);
vi.mock("../src/services/session", () => ({ openExternal: (url: string) => openExternal(url) }));

const { SignedOut } = await import("../src/pages/SignedOut");
const { Register, validateSignUp } = await import("../src/pages/Register");

const en = MESSAGES.en.register;
// The nickname label also carries a visual "*" and a screen-reader "(required)".
const nicknameLabel = (locale: Locale = "en") => new RegExp(`^${MESSAGES[locale].personal.nickname.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
type Handler = (path: string, body: Record<string, unknown>) => { status: number; body?: unknown; headers?: Record<string, string> };
let routes: Record<string, Handler>;
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];

function fakeIdentity(extra: Record<string, Handler> = {}) {
  routes = {
    "GET /v1/config": () => ({ status: 200, body: { registration_open: true, google_available: true, password: { min: 6, max: 128 }, code_length: 8 } }),
    "POST /v1/registrations": (_p, body) => ({ status: 202, body: { registration_id: "11111111-1111-4111-8111-111111111111", registration_secret: "s3cret", email: String(body.email).toLowerCase(), code_length: 8, code_expires_at: "2026-11-17T12:30:00Z", resend_available_at: "2026-11-17T12:01:00Z", expires_at: "2026-11-18T12:00:00Z" } }),
    "POST /v1/registrations/11111111-1111-4111-8111-111111111111/confirmation": (_p, body) => body.code === "12345678" ? { status: 201, body: { status: "confirmed", email: "new@example.org" } } : { status: 422, body: { error: "invalid_code", attempts_remaining: 4 } },
    "POST /v1/registrations/11111111-1111-4111-8111-111111111111/resend": () => ({ status: 202, body: { code_expires_at: "x", resend_available_at: "y", resends_remaining: 3 } }),
    ...extra,
  };
  requests.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(IDENTITY_ORIGIN); // only the identity service, never Rails or anything else
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path: `${init?.method ?? "GET"} ${url.pathname}`, body });
    const handler = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    const result = handler ? handler(url.pathname, body) : { status: 404, body: { error: "not_found" } };
    return new Response(result.status === 204 ? null : JSON.stringify(result.body ?? {}), { status: result.status, headers: result.headers });
  });
}

function show(locale: Locale = "en", onBack = vi.fn()) {
  render(<I18nProvider initial={locale}><Register onBack={onBack} /></I18nProvider>);
  return onBack;
}

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

function fillForm({ email = "New@Example.org", password = "a unique passphrase", confirmation, nickname = "Billie" }: { email?: string; password?: string; confirmation?: string; nickname?: string | null } = {}) {
  if (nickname !== null) type(nicknameLabel(), nickname);
  type(en.email, email);
  type(en.password, password);
  type(en.confirmPassword, confirmation ?? password);
}

beforeEach(() => { fakeIdentity(); signIn.mockReset(); signIn.mockResolvedValue(undefined); openExternal.mockClear(); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("navigation", () => {
  it("Create an account opens the in-app screen (no website), and Back returns to Sign In with the email kept", async () => {
    render(<I18nProvider initial="en"><SignedOut /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.login.createAccount }));
    expect(await screen.findByRole("heading", { name: en.heading })).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
    type(en.email, "back@example.org");
    fireEvent.click(screen.getByRole("button", { name: en.signIn }));
    expect(await screen.findByRole("heading", { name: MESSAGES.en.login.heading })).toBeTruthy();
    expect((screen.getByLabelText(MESSAGES.en.login.email) as HTMLInputElement).value).toBe("back@example.org");
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.login.createAccount }));
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(en.back) }));
    expect(await screen.findByRole("heading", { name: MESSAGES.en.login.heading })).toBeTruthy();
  });

  it("the sign-in screen never links to the website's sign-up page", () => {
    for (const file of ["src/pages/Login.tsx", "src/pages/Register.tsx", "src/pages/SignedOut.tsx", "src/services/account.ts"]) {
      expect(readFileSync(join(__dirname, "..", file), "utf8")).not.toMatch(/sign_up/);
    }
  });
});

describe("validation", () => {
  it("defaults the region to Global Citizen and checks every field before sending anything", async () => {
    show();
    const region = screen.getByLabelText(en.region) as HTMLSelectElement;
    expect(region.value).toBe(GLOBAL_CITIZEN);
    expect(region.options[0].textContent).toBe(en.globalCitizen);
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(screen.getByRole("alert").textContent).toBe(en.fix);
    const email = screen.getByLabelText(en.email);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(en.fields.email_blank)).toBeTruthy();
    expect(screen.getByText(en.fields.password_blank)).toBeTruthy();
    // The nickname is required and comes first, so focus moves there.
    const nickname = screen.getByLabelText(nicknameLabel());
    expect(nickname.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(MESSAGES.en.personal.nickname.errors.blank)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(nickname)); // focus moves to the first problem
    expect(requests.filter((r) => r.path.startsWith("POST"))).toEqual([]);
  });

  it.each([
    [{ email: "no-at-sign" }, en.fields.email_invalid],
    [{ password: "short", confirmation: "short" }, en.fields.password_too_short.replace("{min}", "6")],
    [{ confirmation: "different" }, en.fields.password_confirmation_mismatch],
  ])("rejects %o", (values, message) => {
    show();
    fillForm(values);
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("mirrors the server rules", () => {
    const base = { nickname: "Billie", region: "JP", email: "a@b.c", password: "123456", confirmation: "123456" };
    expect(validateSignUp(base)).toEqual({});
    // Required, trimmed, any script, at most 40 characters (code points, like the server).
    expect(validateSignUp({ ...base, nickname: "" })).toEqual({ nickname: ["blank"] });
    expect(validateSignUp({ ...base, nickname: " \t\u3000 " })).toEqual({ nickname: ["blank"] });
    expect(validateSignUp({ ...base, nickname: "\u200b" })).toEqual({ nickname: ["blank"] });
    expect(validateSignUp({ ...base, nickname: "Bil\u0007lie" })).toEqual({ nickname: ["invalid"] });
    for (const nickname of ["小雨", "ジュン", "윤", "José", "🌤".repeat(40)]) expect(validateSignUp({ ...base, nickname })).toEqual({});
    expect(validateSignUp({ ...base, region: "" })).toEqual({ usage_region: ["blank"] });
    expect(validateSignUp({ ...base, region: "ZZ" })).toEqual({ usage_region: ["inclusion"] });
    expect(validateSignUp({ ...base, region: "XG" })).toEqual({});
    expect(validateSignUp({ ...base, nickname: "n".repeat(41) })).toEqual({ nickname: ["too_long"] });
    expect(validateSignUp({ ...base, password: "x".repeat(129), confirmation: "x".repeat(129) })).toEqual({ password: ["too_long"] });
  });

  it("shows the server's field errors (e.g. a breached password, an unknown region)", async () => {
    fakeIdentity({ "POST /v1/registrations": () => ({ status: 422, body: { error: "invalid", fields: { password: ["pwned"], usage_region: ["inclusion"] } } }) });
    show();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(await screen.findByText(en.fields.password_pwned)).toBeTruthy();
    expect(screen.getByText(en.fields.usage_region_inclusion)).toBeTruthy();
    expect(screen.getByLabelText(en.region).getAttribute("aria-invalid")).toBe("true");
  });

  it("the region list is Rails' list, Global Citizen first, names in the interface language, searchable", () => {
    const rails = join(__dirname, "../../../app/models/usage_region.rb");
    if (existsSync(rails)) {
      const block = /STANDARD_CODES = %w\[([\s\S]*?)\]/.exec(readFileSync(rails, "utf8"))![1];
      expect([...REGION_CODES].sort()).toEqual(block.trim().split(/\s+/).sort());
    }
    const ja = regionOptions("ja", "地球市民");
    expect(ja[0]).toEqual({ code: "XG", label: "地球市民" });
    expect(ja.find((option) => option.code === "JP")?.label).toBe("日本");
    expect(ja[1]).toEqual({ code: "XO", label: "その他" });
    expect(regionOptions("en", "Global Citizen").find((option) => option.code === "KR")?.label).toBe("Korea");
    show();
    const search = screen.getByLabelText(en.regionSearch);
    fireEvent.change(search, { target: { value: "japan" } });
    expect((screen.getByLabelText(en.region) as HTMLSelectElement).value).toBe("JP"); // a single match is chosen
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText(en.regionNoMatch)).toBeTruthy();
    expect((screen.getByLabelText(en.region) as HTMLSelectElement).value).toBe("JP"); // the choice is kept
  });
});

describe("email registration", () => {
  it("says plainly that the code was not emailed when the identity service writes to a local outbox", async () => {
    fakeIdentity({ "GET /v1/config": () => ({ status: 200, body: { registration_open: true, google_available: true, password: { min: 6, max: 128 }, code_length: 8, mail_delivery: "outbox" } }) });
    show("en");
    await waitFor(() => expect(requests.some((r) => r.path === "GET /v1/config")).toBe(true));
    fireEvent.change(screen.getByLabelText(en.region), { target: { value: "JP" } });
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(await screen.findByRole("heading", { name: en.verify.heading })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe(en.verify.devOutbox);
  });

  it("shows no development notice when the service really emails", async () => {
    show("en");
    fireEvent.change(screen.getByLabelText(en.region), { target: { value: "JP" } });
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(await screen.findByRole("heading", { name: en.verify.heading })).toBeTruthy();
    expect(screen.queryByText(en.verify.devOutbox)).toBeNull();
  });

  it("explains a permanently rejected address", async () => {
    fakeIdentity({ "POST /v1/registrations": () => ({ status: 422, body: { error: "mail_rejected" } }) });
    show("en");
    fireEvent.change(screen.getByLabelText(en.region), { target: { value: "JP" } });
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(await screen.findByText(en.errors.mail_rejected)).toBeTruthy();
  });

  it("sends only sign-up details, asks for the emailed code, then signs in through the existing account flow", async () => {
    show("en");
    fireEvent.change(screen.getByLabelText(en.region), { target: { value: "JP" } });
    fillForm({ nickname: "  Billie  " });
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(await screen.findByRole("heading", { name: en.verify.heading })).toBeTruthy();
    expect(screen.getByText(/new@example.org/)).toBeTruthy();
    const sent = requests.find((r) => r.path === "POST /v1/registrations")!;
    expect(Object.keys(sent.body).sort()).toEqual(["email", "locale", "nickname", "password", "password_confirmation", "usage_region"]);
    expect(sent.body).toMatchObject({ email: "New@Example.org", usage_region: "JP", nickname: "Billie", locale: "en" });

    // Heading receives focus for keyboard and screen-reader users.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: en.verify.heading })));

    type(en.verify.code, "1234-5678");
    fireEvent.submit(screen.getByLabelText(en.verify.code).closest("form")!); // Enter key
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("new@example.org", "a unique passphrase"));
    expect(requests.at(-1)).toEqual({ path: "POST /v1/registrations/11111111-1111-4111-8111-111111111111/confirmation", body: { registration_secret: "s3cret", code: "12345678" } });
    // Nothing about the sign-up is persisted on the device.
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/passphrase|s3cret/);
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/passphrase|s3cret/);
  });

  it("explains a wrong code and how many attempts remain", async () => {
    show();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    await screen.findByRole("heading", { name: en.verify.heading });
    type(en.verify.code, "00000000");
    fireEvent.click(screen.getByRole("button", { name: en.verify.submit }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.errors.invalid_code.replace("{remaining}", "4"));
    expect(signIn).not.toHaveBeenCalled();
  });

  it("says how long the code is when some digits are missing", async () => {
    show();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    await screen.findByRole("heading", { name: en.verify.heading });
    const before = requests.length;
    type(en.verify.code, "123456");
    fireEvent.click(screen.getByRole("button", { name: en.verify.submit }));
    expect(await screen.findByText("Enter all 8 digits of the code.")).toBeTruthy();
    expect(requests.length).toBe(before);
  });

  it("resend waits 60 seconds, then sends a new code; the server's rate limit is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    await screen.findByRole("heading", { name: en.verify.heading });
    const waiting = screen.getByRole("button", { name: /Send a new code in \d+s/ }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    await act(async () => {}); // let the countdown effect start
    await act(async () => { vi.advanceTimersByTime(61_000); });
    fireEvent.click(screen.getByRole("button", { name: en.verify.resend }));
    expect((await screen.findByRole("status")).textContent).toBe(en.verify.resent);
    routes["POST /v1/registrations/11111111-1111-4111-8111-111111111111/resend"] = () => ({ status: 429, body: { error: "resend_limit" } });
    await act(async () => { vi.advanceTimersByTime(61_000); });
    fireEvent.click(screen.getByRole("button", { name: en.verify.resend }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.errors.resend_limit);
  });

  it("an address registered meanwhile returns to the form with a clear message", async () => {
    fakeIdentity({ "POST /v1/registrations/11111111-1111-4111-8111-111111111111/confirmation": () => ({ status: 409, body: { error: "email_taken" } }) });
    show();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    await screen.findByRole("heading", { name: en.verify.heading });
    type(en.verify.code, "12345678");
    fireEvent.click(screen.getByRole("button", { name: en.verify.submit }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.errors.email_taken);
    expect(screen.getByRole("heading", { name: en.heading })).toBeTruthy();
  });

  it("if signing in fails after the account was created, says so and offers Sign In", async () => {
    signIn.mockRejectedValue(new Error("offline"));
    const onBack = show();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    await screen.findByRole("heading", { name: en.verify.heading });
    type(en.verify.code, "12345678");
    fireEvent.click(screen.getByRole("button", { name: en.verify.submit }));
    expect(await screen.findByText(en.done.signInFailed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.done.signIn }));
    expect(onBack).toHaveBeenCalledWith("new@example.org");
  });

  it.each([
    ["local_server_down", en.errors.local_server_down.replace("{host}", "localhost:8100")],
    ["offline", en.errors.offline],
    ["rate_limited", en.errors.rate_limited],
    ["registration_closed", en.errors.registration_closed],
  ])("reports %s", async (code, message) => {
    if (code === "offline") vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    if (code === "offline" || code === "local_server_down") vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    else fakeIdentity({ "POST /v1/registrations": () => ({ status: code === "rate_limited" ? 429 : 403, body: { error: code } }) });
    show();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });
});

describe("email verification switched off on the identity service", () => {
  const created = () => fakeIdentity({
    "GET /v1/config": () => ({ status: 200, body: { registration_open: true, google_available: false, password: { min: 6, max: 128 }, code_length: 8, email_verification: "disabled" } }),
    "POST /v1/registrations": (_p, body) => ({ status: 201, body: { status: "created", email: String(body.email).trim().toLowerCase(), nickname: body.nickname, email_verified: false } }),
  });

  it("Create Account → account created → signed in: no code screen, no countdown, no confirmation call", async () => {
    created();
    let finishSignIn: () => void = () => undefined;
    signIn.mockImplementation(() => new Promise<void>((resolve) => { finishSignIn = resolve; }));
    show("en");
    fillForm({ email: "iamlu@163.com", nickname: " Jyun " });
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(await screen.findByRole("heading", { name: en.done.heading })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(en.done.signingIn);
    expect(signIn).toHaveBeenCalledWith("iamlu@163.com", "a unique passphrase");
    expect(screen.queryByRole("heading", { name: en.verify.heading })).toBeNull();
    expect(screen.queryByLabelText(en.verify.code)).toBeNull();
    expect(screen.queryByText(/Send a new code/)).toBeNull();
    expect(requests.map((r) => r.path)).toEqual(["GET /v1/config", "POST /v1/registrations"]);
    expect(requests[1].body).toMatchObject({ nickname: "Jyun" });
    await act(async () => finishSignIn());
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/passphrase/);
  });

  it("a duplicate address stays on the form with a clear message", async () => {
    created();
    routes["POST /v1/registrations"] = () => ({ status: 409, body: { error: "email_taken" } });
    show("en");
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.errors.email_taken);
    expect(screen.getByRole("heading", { name: en.heading })).toBeTruthy();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("the nickname is still required before anything is sent", async () => {
    created();
    show("en");
    fillForm({ nickname: "   " });
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(screen.getByText(MESSAGES.en.personal.nickname.errors.blank)).toBeTruthy();
    expect(requests.filter((r) => r.path.startsWith("POST"))).toEqual([]);
  });

  it("if signing in fails, the created account is reported with a way to sign in", async () => {
    created();
    signIn.mockRejectedValue(new Error("offline"));
    const onBack = show("en");
    fillForm({ email: "jyun@example.org", nickname: "Jyun" });
    fireEvent.click(screen.getByRole("button", { name: en.submit }));
    expect(await screen.findByText(en.done.signInFailed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.done.signIn }));
    expect(onBack).toHaveBeenCalledWith("jyun@example.org");
  });

  it.each(LOCALES.map((locale) => [locale]))("works the same in %s", async (locale) => {
    created();
    show(locale as Locale);
    const r = MESSAGES[locale as Locale].register;
    fireEvent.change(screen.getByLabelText(nicknameLabel(locale as Locale)), { target: { value: "Jyun" } });
    fireEvent.change(screen.getByLabelText(r.email), { target: { value: "jyun@example.org" } });
    fireEvent.change(screen.getByLabelText(r.password), { target: { value: "a unique passphrase" } });
    fireEvent.change(screen.getByLabelText(r.confirmPassword), { target: { value: "a unique passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: r.submit }));
    expect(await screen.findByRole("heading", { name: r.done.heading })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: r.verify.heading })).toBeNull();
    expect(requests.at(-1)!.body).toMatchObject({ locale });
  });
});

describe("account service status", () => {
  it("reproduces the installed-app failure: the identity service is not running → says so up front, and Retry recovers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    show();
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain(en.errors.local_server_down.replace("{host}", "localhost:8100"));
    expect(banner.textContent).not.toContain(en.errors.offline);
    fetchSpy.mockRestore();
    fakeIdentity(); // the service is started
    fireEvent.click(within(banner).getByRole("button", { name: en.retry }));
    await waitFor(() => expect(screen.queryByText(/isn't running/)).toBeNull());
    expect(requests.map((r) => r.path)).toContain("GET /v1/config");
  });
});

describe("Google", () => {
  const flowId = "22222222-2222-4222-8222-222222222222";
  let status: Record<string, unknown>;
  beforeEach(() => {
    status = { status: "started" };
    fakeIdentity({
      "POST /v1/google/flows": (_p, body) => {
        expect(body.code_challenge_method).toBe("S256");
        expect(String(body.code_challenge)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return { status: 201, body: { flow_id: flowId, authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?state=x", expires_at: "z" } };
      },
      [`POST /v1/google/flows/${flowId}/status`]: (_p, body) => { expect(String(body.code_verifier).length).toBeGreaterThanOrEqual(43); return { status: 200, body: status }; },
      [`POST /v1/google/flows/${flowId}/complete`]: () => ({ status: 201, body: { status: "created", email: "g@example.org" } }),
      [`POST /v1/google/flows/${flowId}/link`]: (_p, body) => body.password === "website pass" ? { status: 200, body: { status: "linked", email: "g@example.org" } } : { status: 422, body: { error: "invalid_password", attempts_remaining: 4 } },
      [`POST /v1/google/flows/${flowId}/cancel`]: () => ({ status: 204 }),
    });
  });

  async function startGoogle() {
    show();
    fireEvent.click(await screen.findByRole("button", { name: en.googleButton }));
    expect(await screen.findByRole("heading", { name: en.googleFlow.waiting })).toBeTruthy();
    // The system browser opens Google; no WebView, no Google page inside the app.
    expect(openExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=x");
  }

  it("new account: Google verifies the email, the person sets the region and an app password, then signs in", async () => {
    await startGoogle();
    status = { status: "verified", outcome: "new_account", email: "g@example.org" };
    expect(await screen.findByRole("heading", { name: en.googleFlow.newHeading }, { timeout: 4000 })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(en.region), { target: { value: "KR" } });
    // Required here too; nothing from the Google profile is filled in.
    expect((screen.getByLabelText(nicknameLabel()) as HTMLInputElement).value).toBe("");
    type(nicknameLabel(), "윤");
    type(en.password, "google app pass");
    type(en.confirmPassword, "google app pass");
    fireEvent.click(screen.getByRole("button", { name: en.googleFlow.create }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("g@example.org", "google app pass"));
    const complete = requests.find((r) => r.path.endsWith("/complete"))!;
    expect(Object.keys(complete.body).sort()).toEqual(["code_verifier", "nickname", "password", "password_confirmation", "usage_region"]);
    expect(complete.body.usage_region).toBe("KR");
    expect(complete.body.nickname).toBe("윤");
  });

  it("existing account: linking needs that account's password", async () => {
    await startGoogle();
    status = { status: "verified", outcome: "link_required", email: "g@example.org" };
    await screen.findByRole("heading", { name: en.googleFlow.linkHeading }, { timeout: 4000 });
    type(en.password, "guess");
    fireEvent.click(screen.getByRole("button", { name: en.googleFlow.link }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.errors.invalid_password.replace("{remaining}", "4"));
    type(en.password, "website pass");
    fireEvent.click(screen.getByRole("button", { name: en.googleFlow.link }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("g@example.org", "website pass"));
  });

  it("cancelled in the browser: back to the form, nothing created", async () => {
    await startGoogle();
    status = { status: "cancelled", failure: "cancelled" };
    expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toBe(en.googleFlow.cancelled);
    expect(screen.getByRole("heading", { name: en.heading })).toBeTruthy();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("cancelled in the app: tells the service and returns to the form", async () => {
    await startGoogle();
    fireEvent.click(screen.getByRole("button", { name: en.googleFlow.cancel }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.googleFlow.cancelled);
    expect(requests.some((r) => r.path === `POST /v1/google/flows/${flowId}/cancel`)).toBe(true);
  });

  it("failure at Google is explained", async () => {
    await startGoogle();
    status = { status: "failed", failure: "unverified_email" };
    expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toBe(en.googleFlow.failed);
  });

  it("two-factor accounts are sent to the normal sign-in", async () => {
    const onBack = vi.fn();
    show("en", onBack);
    fireEvent.click(await screen.findByRole("button", { name: en.googleButton }));
    await screen.findByRole("heading", { name: en.googleFlow.waiting });
    status = { status: "verified", outcome: "unavailable", failure: "otp_required", email: "g@example.org" };
    expect(await screen.findByText(en.googleFlow.otp_required, {}, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.signIn }));
    expect(onBack).toHaveBeenCalledWith("g@example.org");
  });

  it("the Google button is hidden when the service has no Google client", async () => {
    fakeIdentity({ "GET /v1/config": () => ({ status: 200, body: { registration_open: true, google_available: false, password: { min: 6, max: 128 } } }) });
    show();
    await waitFor(() => expect(requests.some((r) => r.path === "GET /v1/config")).toBe(true));
    expect(screen.queryByRole("button", { name: en.googleButton })).toBeNull();
  });
});

describe("localization and accessibility", () => {
  it.each(LOCALES)("%s: every control is labelled in the interface language", (locale) => {
    const r = MESSAGES[locale].register;
    show(locale);
    for (const label of [nicknameLabel(locale), r.region, r.regionSearch, r.email, r.password, r.confirmPassword]) expect(screen.getByLabelText(label)).toBeTruthy();
    const nickname = screen.getByLabelText(nicknameLabel(locale)) as HTMLInputElement;
    expect(nickname.required).toBe(true);
    expect(nickname.placeholder).toBe(MESSAGES[locale].personal.nickname.placeholder);
    expect(document.getElementById(nickname.getAttribute("aria-describedby")!)!.textContent).toBe(MESSAGES[locale].personal.nickname.help);
    expect(screen.getByRole("heading", { level: 1, name: r.heading })).toBeTruthy();
    expect(screen.getByRole("button", { name: r.submit })).toBeTruthy();
    expect((screen.getByLabelText(r.region) as HTMLSelectElement).options[0].textContent).toBe(r.globalCitizen);
    cleanup();
  });

  it("password visibility toggles are real buttons with state", () => {
    show();
    const password = screen.getByLabelText(en.password) as HTMLInputElement;
    const field = password.closest(".bw-field") as HTMLElement;
    const toggle = within(field).getByRole("button", { name: en.show });
    expect(password.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(password.id);
    fireEvent.click(toggle);
    expect(password.type).toBe("text");
    expect(within(field).getByRole("button", { name: en.hide }).getAttribute("aria-pressed")).toBe("true");
  });

  it("help and error text are tied to their fields", () => {
    show();
    const password = screen.getByLabelText(en.password);
    const describedBy = password.getAttribute("aria-describedby")!.split(" ");
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain(en.passwordHelp.replace("{min}", "6"));
    expect(screen.getByLabelText(en.email).getAttribute("autocomplete")).toBe("email");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
  });

  it("has phone, tablet and desktop layouts", () => {
    const css = readFileSync(join(__dirname, "../src/pages/Register.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 760px\)/);
    expect(css).toMatch(/@media \(min-width: 761px\)/);
    expect(css).toMatch(/\.bw-password-toggle \{[^}]*min-height: 44px/); // touch target
  });
});

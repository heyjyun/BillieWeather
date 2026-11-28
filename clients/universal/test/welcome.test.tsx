// @vitest-environment jsdom
// The in-app Welcome page: shown once to a newly registered account after it signs in, never to
// existing accounts, never before a successful (verified) sign-in, scoped per account, and never
// a browser window, an email preview, a network call or a database write. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { I18nProvider, LOCALES, MESSAGES } from "../src/i18n";
import { resetDeepLinksForTests } from "../src/services/deepLink";
import { NEW_ACCOUNT_DAYS, isNewAccount, isWelcomeDone, markWelcomeDone, shouldShowWelcome } from "../src/services/onboarding";
import { Welcome } from "../src/pages/Welcome";

const files = new Map<string, ReturnType<typeof sqljsDriver>>();
const g = globalThis as { __seedRows?: boolean; __owner?: string };
vi.mock("../src/services/platform", async () => {
  const SQL = await initSqlJs();
  return {
    isTauri: () => false,
    openDatabase: async (file = "billieweather.db") => {
      if (!files.has(file)) {
        const db = new SQL.Database();
        migrate(db);
        db.run("INSERT INTO settings (key, value) VALUES ('database_name', 'Test Mac')");
        db.run("INSERT INTO settings (key, value) VALUES ('owner_account_id', ?)", [g.__owner ?? ""]);
        if (g.__seedRows) {
          db.run("INSERT INTO statements (filename, currency, sha256, transaction_count, imported_at) VALUES ('old.csv','USD','s1',1,'2026-01-01')");
          db.run("INSERT INTO transactions (statement_id, booked_on, description, amount_cents, category, updated_at, kind) VALUES (1,'2026-01-02','EXISTING ROW',-500,'Shopping','x','expense')");
          db.run("INSERT INTO settings (key, value) VALUES ('currency','USD')");
        }
        files.set(file, sqljsDriver(db));
      }
      return { driver: files.get(file)!, persistent: true };
    },
    deviceName: async () => "Test Mac",
    deviceIdentity: async () => null,
    saveFile: async () => true,
    listSnapshots: async () => [],
  };
});

const { default: App } = await import("../src/App");

const ALICE = { email: "alice@example.com", owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const BOB = { email: "bob@example.com", owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

let who = { ...ALICE, registered_at: daysAgo(1) as string | null, nickname: null as string | null };
let signInError: string | null = null;
let calls: Array<{ url: string; method: string }> = [];
const accountJson = () => ({ email: who.email, nickname: who.nickname, locale: "en", time_zone: null, usage_region: "US", registered_at: who.registered_at, badges: [], owner_id: who.owner_id });

function fakeServer() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/api/client/v1/session") && init?.method === "POST") {
      return signInError ? json({ error: signInError }, 401) : json({ token: "tok", expires_at: daysAgo(-30), account: accountJson() }, 201);
    }
    if (url.endsWith("/api/client/v1/account")) return json({ account: accountJson() });
    // The website has nothing for a new account.
    return json({ currency: null, version: "0", statement_count: 0, transaction_count: 0, statements: [], transactions: [], next_after_id: null, rules: [], categories: [] });
  });
}

/** Opens the app with a saved session for `account` (as after a sign-in on an earlier launch). */
function launchAs(account: Partial<typeof who>) {
  cleanup();
  who = { ...who, ...account };
  g.__owner = `id:${who.owner_id}`;
  sessionStorage.setItem("billie.token", "tok");
  localStorage.removeItem("billie.account");
  render(<App />);
}

// "Welcome to BillieWeather!" or, with a nickname, "Welcome to BillieWeather, Billie!".
const WELCOME_TITLE = /^Welcome to BillieWeather/;
const welcomeHeading = () => screen.findByRole("heading", { level: 2, name: WELCOME_TITLE });
const noWelcome = () => expect(screen.queryByRole("heading", { name: WELCOME_TITLE })).toBeNull();
// Overview opens with its module title after onboarding.
const dashboard = () => screen.findByRole("heading", { level: 1, name: "Financial Overview" });
const welcomeKey = (ownerId: string) => `billie.welcome.id:${ownerId}`;
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); files.clear(); calls = []; signInError = null; g.__seedRows = false;
  localStorage.setItem("billie.locale", "en");
  who = { ...ALICE, registered_at: daysAgo(1), nickname: null };
  g.__owner = `id:${ALICE.owner_id}`;
  window.history.replaceState(null, "", "/");
  resetDeepLinksForTests();
  fakeServer();
  openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("new account", () => {
  it("signs in through the app, sees the welcome, and Get Started opens the import workflow", async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText(MESSAGES.en.login.email), { target: { value: ALICE.email } });
    fireEvent.change(screen.getByLabelText(MESSAGES.en.login.password), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.login.submit }));

    expect(await welcomeHeading()).toBeTruthy();
    expect(await dashboard()).toBeTruthy();
    expect((await welcomeHeading()).textContent).toBe(MESSAGES.en.personal.welcome.title.plain);
    expect(screen.getByText(MESSAGES.en.personal.welcome.subtitle)).toBeTruthy();
    const steps = screen.getByRole("list", { name: MESSAGES.en.welcome.stepsLabel });
    expect([...steps.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Bring your finances together", "Let AI organize the details", "See what's coming",
    ]);
    expect(steps.textContent).toContain("Import statements and receipts securely.");
    expect(steps.textContent).toContain("Review smart transaction categorization.");
    expect(steps.textContent).toContain("Explore your cash-flow forecast.");
    // A fresh account lands on Financial Overview with onboarding inside the page.
    const nav = screen.getByRole("navigation", { name: MESSAGES.en.nav.main });
    expect([...nav.querySelectorAll("#module-nav button")].map((node) => node.textContent)).toEqual(["Financial Overview", "AI Insight"]);
    expect(nav.querySelector('#module-nav [aria-current="page"]')?.textContent).toBe("Financial Overview");
    expect(nav.querySelector(".bw-nav-bottom > .bw-system-nav + .bw-nav-user")).toBeTruthy();
    expect(localStorage.getItem(welcomeKey(ALICE.owner_id))).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.welcome.start }));
    expect(await screen.findByRole("heading", { level: 1, name: MESSAGES.en.import.title })).toBeTruthy();
    noWelcome();
    expect(localStorage.getItem(welcomeKey(ALICE.owner_id))).not.toBeNull();
    expect(screen.getByRole("navigation", { name: MESSAGES.en.nav.main })).toBeTruthy();
  });

  it("Explore Dashboard opens the dashboard; the welcome is not shown on later launches", async () => {
    launchAs({});
    expect(await welcomeHeading()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.welcome.explore }));
    expect(await dashboard()).toBeTruthy();
    noWelcome();

    launchAs({});
    expect(await dashboard()).toBeTruthy();
    noWelcome();
  });

  it("greets by nickname when the account has one (and never shows the email)", async () => {
    launchAs({ nickname: "Billie" });
    expect(await welcomeHeading()).toBeTruthy();
    expect((await welcomeHeading()).textContent).toBe("Welcome to BillieWeather, Billie!");
    // The name appears once, in the headline, not in every line.
    expect(document.querySelector(".bw-welcome")!.textContent!.split("Billie!").length - 1).toBe(1);
    expect(document.querySelector(".bw-welcome")!.textContent).not.toContain(ALICE.email);
  });

  it("interrupted onboarding (app closed on the welcome) shows it again next launch", async () => {
    launchAs({});
    expect(await welcomeHeading()).toBeTruthy();
    launchAs({}); // closed without pressing anything
    expect(await welcomeHeading()).toBeTruthy();
    expect(isWelcomeDone(`id:${ALICE.owner_id}`)).toBe(false);
  });
});

describe("who does not see it", () => {
  it("an existing account goes straight to its dashboard", async () => {
    launchAs({ registered_at: daysAgo(400) });
    expect(await dashboard()).toBeTruthy();
    noWelcome();
  });

  it("an older server that does not send registered_at never triggers it", async () => {
    launchAs({ registered_at: null });
    expect(await dashboard()).toBeTruthy();
    noWelcome();
  });

  it("a new account whose local book already has data goes to the dashboard (and the data is untouched)", async () => {
    g.__seedRows = true;
    launchAs({});
    expect(await dashboard()).toBeTruthy();
    noWelcome();
    const rows = await files.get("billieweather.db")!.select<{ description: string }>("SELECT description FROM transactions");
    expect(rows.map((r) => r.description)).toEqual(["EXISTING ROW"]);
  });
});

describe("email verification", () => {
  it("an unverified account gets an explanation on the sign-in screen, no session and no welcome", async () => {
    signInError = "unconfirmed";
    render(<App />);
    fireEvent.change(await screen.findByLabelText(MESSAGES.en.login.email), { target: { value: ALICE.email } });
    fireEvent.change(screen.getByLabelText(MESSAGES.en.login.password), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.login.submit }));
    expect((await screen.findByRole("alert")).textContent).toBe(MESSAGES.en.login.errors.unconfirmed);
    noWelcome();
    expect(sessionStorage.getItem("billie.token")).toBeNull();

    // After verifying, the same account signs in and is welcomed.
    signInError = null;
    fireEvent.change(screen.getByLabelText(MESSAGES.en.login.password), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.login.submit }));
    expect(await welcomeHeading()).toBeTruthy();
  });

  it("the unconfirmed message exists in every language", () => {
    for (const locale of LOCALES) expect(MESSAGES[locale].login.errors.unconfirmed.length).toBeGreaterThan(10);
  });
});

describe("accounts and devices", () => {
  it("completion is per account: switching to another new account shows it for that account only", async () => {
    launchAs({ ...ALICE });
    expect(await welcomeHeading()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.welcome.explore }));
    expect(await dashboard()).toBeTruthy();

    files.clear(); // Bob's own book on this device
    launchAs({ ...BOB });
    expect(await welcomeHeading()).toBeTruthy();
    expect(localStorage.getItem(welcomeKey(BOB.owner_id))).toBeNull();
    expect(localStorage.getItem(welcomeKey(ALICE.owner_id))).not.toBeNull();

    files.clear();
    launchAs({ ...ALICE });
    expect(await dashboard()).toBeTruthy();
    noWelcome();
  });

  it("a Google-registered account (created on the website, then signed in to the app) is welcomed once, with the same account id", async () => {
    // Google sign-up happens on the website; the app sees an ordinary new account with the same immutable owner id.
    launchAs({ email: "google-user@example.com", owner_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect(await welcomeHeading()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.welcome.start }));
    expect(await screen.findByRole("heading", { level: 1, name: MESSAGES.en.import.title })).toBeTruthy();
    expect(localStorage.getItem(welcomeKey("cccccccc-cccc-4ccc-8ccc-cccccccccccc"))).not.toBeNull();
    // No additional account was created by the app: it only ever calls sign-in/account/read-only sync.
    expect(calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/session"))).toEqual([]);
  });

  it("returning to the app with billieweather://open keeps the welcome; a capture link opens its screen without finishing it", async () => {
    launchAs({});
    expect(await welcomeHeading()).toBeTruthy();
    await act(async () => { window.location.hash = "#/open"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByRole("heading", { name: WELCOME_TITLE })).toBeTruthy();

    await act(async () => { window.location.hash = "#/capture/receipt"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(await screen.findByRole("heading", { name: MESSAGES.en.receipt.title })).toBeTruthy();
    noWelcome();
    expect(isWelcomeDone(`id:${ALICE.owner_id}`)).toBe(false);
  });

  it("an app launched by a capture link skips straight to that screen", async () => {
    window.history.replaceState(null, "", "/#/capture/receipt");
    launchAs({});
    expect(await screen.findByRole("heading", { name: MESSAGES.en.receipt.title })).toBeTruthy();
    noWelcome();
  });
});

describe("privacy and side effects", () => {
  it("opens no browser window or email preview, and makes no extra network request", async () => {
    launchAs({ registered_at: daysAgo(400) });
    expect(await dashboard()).toBeTruthy();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const baseline = new Set(calls.map((c) => `${c.method} ${c.url}`));

    files.clear(); calls = [];
    launchAs({ registered_at: daysAgo(1) });
    expect(await welcomeHeading()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.welcome.start }));
    expect(await screen.findByRole("heading", { level: 1, name: MESSAGES.en.import.title })).toBeTruthy();

    expect(openSpy).not.toHaveBeenCalled();
    expect(calls.filter((c) => !baseline.has(`${c.method} ${c.url}`))).toEqual([]);
    expect(calls.some((c) => /letter_opener|rails\/mailers|mail/i.test(c.url))).toBe(false);
  });

  it("the page cannot read or change financial data, call the network, AI, sync, or open URLs", () => {
    const source = readFileSync(join(__dirname, "../src/pages/Welcome.tsx"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../components/BrandMark", "../i18n", "../services/greeting", "../services/profile", "@billie/design-tokens", "react"]);
    // The personalization helpers it uses are pure: no imports at all (no network, storage or data).
    for (const helper of ["greeting.ts", "profile.ts"]) {
      const code = readFileSync(join(__dirname, "../src/services", helper), "utf8");
      expect(code, helper).not.toMatch(/^import /m);
      expect(code, helper).not.toMatch(/fetch\(|localStorage|invoke\(/);
    }
    expect(source).not.toMatch(/useFinance|store|fetch\(|openExternal|window\.open|invoke\(|localStorage/);
    const onboarding = readFileSync(join(__dirname, "../src/services/onboarding.ts"), "utf8");
    expect(onboarding).not.toMatch(/^import /m);
  });
});

describe("Welcome page", () => {
  it.each(LOCALES)("is fully translated in %s", (locale) => {
    const w = MESSAGES[locale].welcome;
    const title = MESSAGES[locale].personal.welcome.title;
    render(<I18nProvider initial={locale}><Welcome onStart={() => undefined} onExplore={() => undefined} /></I18nProvider>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title.plain);
    cleanup();
    render(<I18nProvider initial={locale}><Welcome name=" 小雨 " onStart={() => undefined} onExplore={() => undefined} /></I18nProvider>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title.named.replace("{name}", "小雨"));
    expect(screen.getByRole("button", { name: w.start })).toBeTruthy();
    expect(screen.getByRole("button", { name: w.explore })).toBeTruthy();
    expect(screen.getByText(w.ready)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([w.steps.import.title, w.steps.organize.title, w.steps.forecast.title]);
    if (locale !== "en") expect(title.plain).not.toBe(MESSAGES.en.personal.welcome.title.plain);
  });

  it("is keyboard friendly: focus starts on the headline, buttons are real buttons in reading order", () => {
    const start = vi.fn();
    const explore = vi.fn();
    render(<I18nProvider initial="en"><Welcome onStart={start} onExplore={explore} /></I18nProvider>);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([MESSAGES.en.welcome.start, MESSAGES.en.welcome.explore]);
    buttons.forEach((b) => expect(b.getAttribute("type")).toBe("button"));
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(explore).toHaveBeenCalledTimes(1);
  });

  it("styles cover phones, tablets, safe areas, touch targets and reduced motion", () => {
    const css = readFileSync(join(__dirname, "../src/styles.css"), "utf8");
    const block = css.slice(css.indexOf("/* ---------- Welcome"));
    expect(block).toMatch(/env\(safe-area-inset-top\)/);
    expect(block).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(block).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.bw-welcome-steps \{ grid-template-columns: minmax\(0, 1fr\)/);
    expect(block).toMatch(/@media \(max-width: 600px\)[\s\S]*\.bw-welcome-actions \.bw-button \{ width: 100%/);
    expect(block).toMatch(/\.bw-welcome-actions \.bw-button \{ min-height: 52px/);
    expect(block).not.toMatch(/#[0-9a-f]{3,6}\b/i); // colors come from design tokens (light and dark)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ transition: none !important; animation: none !important; \} \}/);
  });
});

describe("onboarding rules", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  it("a new account is one registered within the window (allowing a slightly slow clock)", () => {
    expect(isNewAccount("2026-11-16T12:00:00Z", now)).toBe(true);
    expect(isNewAccount("2026-11-17T20:00:00Z", now)).toBe(true);
    expect(isNewAccount(new Date(now.getTime() - (NEW_ACCOUNT_DAYS + 1) * 86_400_000).toISOString(), now)).toBe(false);
    expect(isNewAccount("2027-01-01T00:00:00Z", now)).toBe(false);
    expect(isNewAccount(null, now)).toBe(false);
    expect(isNewAccount("not a date", now)).toBe(false);
  });

  it("needs an account, an empty book and no earlier completion for that account", () => {
    localStorage.clear();
    const base = { ownerKey: "id:x", registeredAt: "2026-11-16T00:00:00Z", hasData: false, now };
    expect(shouldShowWelcome(base)).toBe(true);
    expect(shouldShowWelcome({ ...base, ownerKey: null })).toBe(false);
    expect(shouldShowWelcome({ ...base, hasData: true })).toBe(false);
    markWelcomeDone("id:x");
    expect(shouldShowWelcome(base)).toBe(false);
    expect(shouldShowWelcome({ ...base, ownerKey: "id:y" })).toBe(true);
  });

  it("never traps anyone when storage is unavailable", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(isWelcomeDone("id:x")).toBe(true);
    expect(() => markWelcomeDone("id:x")).not.toThrow();
    get.mockRestore(); set.mockRestore();
  });
});

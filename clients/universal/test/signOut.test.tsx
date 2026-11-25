// @vitest-environment jsdom
// P0 sign-out: the server revokes the session, also when the person signed out offline, quit the app,
// or could not save the token. Only a digest is ever remembered.
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { finishSignOuts, revokeToken, tokenDigest } from "../src/services/signOut";
import { AccountProvider, useAccount } from "../src/hooks/useAccount";
import { I18nProvider } from "../src/i18n";
import * as session from "../src/services/session";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const KEY = "billie.revocations";
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "[]") as { digest: string; at: number }[];
const TOKEN = "bwa_secret-token-value-for-tests-0123456789abc";
const accountJson = { email: "a@example.com", nickname: "a", locale: "en", time_zone: null, usage_region: "US", registered_at: null, badges: [], owner_id: "12345678-1234-4123-8123-123456789abc" };

let online = true;
let calls: { method: string; path: string; token: string | null; body: string | null }[] = [];
let statusFor: (method: string, path: string) => number = () => 204;
beforeEach(() => {
  online = true; calls = []; statusFor = () => 204;
  localStorage.clear(); sessionStorage.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (!online) throw new TypeError("Failed to fetch");
    const path = new URL(String(input)).pathname.replace("/api/client/v1", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, token: (init?.headers as Record<string, string>)?.Authorization ?? null, body: (init?.body as string) ?? null });
    if (method === "POST" && path === "/session") return new Response(JSON.stringify({ token: TOKEN, expires_at: "2027-01-01T00:00:00Z", account: accountJson }), { status: 201 });
    if (path === "/account") return new Response(JSON.stringify({ account: accountJson }), { status: 200 });
    if (method === "DELETE" && path === "/sessions") return new Response(JSON.stringify({ revoked: 2 }), { status: statusFor(method, path) === 204 ? 200 : statusFor(method, path) });
    const status = statusFor(method, path);
    return new Response(status === 204 ? null : "{}", { status });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("sign-out queue", () => {
  it("hashes the token exactly as the server does", async () => {
    expect(await tokenDigest(TOKEN)).toBe(sha(TOKEN));
  });

  it("ends the session directly and keeps nothing when the server confirms", async () => {
    await revokeToken(TOKEN);
    expect(calls).toEqual([{ method: "DELETE", path: "/session", token: `Bearer ${TOKEN}`, body: null }]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("offline: remembers only the digest, and finishes when the server is back", async () => {
    online = false;
    await revokeToken(TOKEN);
    expect(stored().map((item) => item.digest)).toEqual([sha(TOKEN)]);
    expect(JSON.stringify(localStorage) + JSON.stringify(sessionStorage)).not.toContain(TOKEN);
    await finishSignOuts();
    expect(stored()).toHaveLength(1);
    online = true;
    await finishSignOuts();
    expect(calls).toEqual([{ method: "POST", path: "/session/revocations", token: null, body: JSON.stringify({ token_digest: sha(TOKEN) }) }]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it.each([429, 500, 502, 404])("keeps the sign-out after HTTP %s", async (status) => {
    statusFor = () => status;
    await revokeToken(TOKEN);
    await finishSignOuts();
    expect(stored()).toHaveLength(1);
    statusFor = () => 204;
    await finishSignOuts();
    expect(stored()).toHaveLength(0);
  });

  it("concurrent retries send each sign-out once", async () => {
    online = false;
    await revokeToken(TOKEN);
    await revokeToken(`${TOKEN}2`);
    online = true;
    await Promise.all([finishSignOuts(), finishSignOuts(), finishSignOuts()]);
    expect(calls.map((call) => call.body)).toEqual([sha(TOKEN), sha(`${TOKEN}2`)].map((token_digest) => JSON.stringify({ token_digest })));
  });

  it("ignores damaged, foreign and long-expired entries", async () => {
    localStorage.setItem(KEY, "{broken");
    await finishSignOuts();
    localStorage.setItem(KEY, JSON.stringify([null, { digest: "xyz", at: Date.now() }, { digest: sha("old"), at: Date.now() - 32 * 86_400_000 }, { digest: 5 }, TOKEN]));
    await finishSignOuts();
    expect(calls).toEqual([]);
  });

  it("still tells the server when nothing can be stored or hashed", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("unavailable"));
    await revokeToken(TOKEN);
    expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
  });
});

describe("account provider", () => {
  function Probe() {
    const { status, signIn, signOut, signOutOthers } = useAccount();
    return <>
      <p>status {status}</p>
      <button onClick={() => void signIn("a@example.com", "pw").catch(() => undefined)}>in</button>
      <button onClick={() => void signOut()}>out</button>
      <button onClick={() => void signOutOthers().catch(() => undefined)}>others</button>
    </>;
  }
  const open = () => render(<I18nProvider><AccountProvider><Probe /></AccountProvider></I18nProvider>);
  const press = async (name: string) => act(async () => { fireEvent.click(screen.getByText(name)); });

  it("signs out on the server and forgets the token at once", async () => {
    sessionStorage.setItem("billie.token", TOKEN);
    open();
    await screen.findByText("status signedIn");
    await press("out");
    await screen.findByText("status signedOut");
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/session" && call.token === `Bearer ${TOKEN}`)).toBe(true));
    expect(sessionStorage.getItem("billie.token")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("finishes an offline sign-out at the next start, and when the network returns", async () => {
    sessionStorage.setItem("billie.token", TOKEN);
    open();
    await screen.findByText("status signedIn");
    online = false;
    await press("out");
    await screen.findByText("status signedOut");
    await waitFor(() => expect(stored()).toHaveLength(1));
    cleanup();
    open(); // restart, still offline
    await screen.findByText("status signedOut");
    expect(stored()).toHaveLength(1);
    online = true;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
  });

  it("revokes a token this device could not save", async () => {
    vi.spyOn(session, "saveToken").mockRejectedValue(new Error("keychain"));
    open();
    await screen.findByText("status signedOut");
    await press("in");
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/session" && call.token === `Bearer ${TOKEN}`)).toBe(true));
    expect(screen.getByText("status signedOut")).toBeTruthy();
  });

  it("signs out other devices with this app's token and stays signed in; a revoked app returns to sign-in", async () => {
    sessionStorage.setItem("billie.token", TOKEN);
    open();
    await screen.findByText("status signedIn");
    await press("others");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/sessions", token: `Bearer ${TOKEN}` });
    expect(screen.getByText("status signedIn")).toBeTruthy();
    statusFor = (method, path) => (method === "DELETE" && path === "/sessions" ? 401 : 204);
    await press("others");
    await screen.findByText("status signedOut");
  });
});

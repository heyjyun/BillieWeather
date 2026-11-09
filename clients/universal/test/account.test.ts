import { AccountError, API_ORIGIN, fetchAccount, signIn, updateAccount, websiteUrl } from "../src/services/account";

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}
const account = { email: "a@example.com", nickname: "jyun", locale: "ja", time_zone: "Tokyo", usage_region: "JP", registered_at: "2026-01-02T03:04:05Z", badges: ["member"] };

afterEach(() => vi.restoreAllMocks());

describe("account service", () => {
  it("signs in with only email, password (and an optional 2FA code), without cookies", async () => {
    const spy = mockFetch(201, { token: "tok", expires_at: "2026-12-01T00:00:00Z", account });
    const result = await signIn("a@example.com", "secret", "123456");
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_ORIGIN}/api/client/v1/session`);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@example.com", password: "secret", otp_attempt: "123456" });
    expect(result.account).toEqual({ email: "a@example.com", nickname: "jyun", locale: "ja", timeZone: "Tokyo", usageRegion: "JP", registeredAt: "2026-01-02T03:04:05Z", badges: ["member"] });
  });

  it("sends the bearer token and only preference fields", async () => {
    const spy = mockFetch(200, { account });
    await updateAccount("tok", { locale: "es", nickname: "B" });
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ account: { locale: "es", nickname: "B" } });
  });

  it.each([
    [401, { error: "invalid_credentials" }, "invalid_credentials"],
    [401, { error: "otp_required" }, "otp_required"],
    [401, { error: "locked" }, "locked"],
    [429, { error: "rate_limited" }, "rate_limited"],
    [401, {}, "unauthorized"],
    [500, {}, "unknown"],
  ])("maps HTTP %s %j to %s", async (status, body, code) => {
    mockFetch(status, body);
    await expect(fetchAccount("tok")).rejects.toMatchObject({ code });
  });

  it("reports offline when the server cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await signIn("a@example.com", "x").catch((e) => e);
    expect(error).toBeInstanceOf(AccountError);
    expect(error.code).toBe("offline");
  });

  it("builds website links on the same server, in the chosen language", () => {
    expect(websiteUrl("/users/sign_up", "zh-CN")).toBe(`${API_ORIGIN}/users/sign_up?locale=zh-CN`);
  });
});

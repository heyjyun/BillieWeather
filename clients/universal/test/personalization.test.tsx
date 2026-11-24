// @vitest-environment jsdom
// Required nickname and personalized greetings in the apps (macOS, Windows, iOS, Android share this code).
// The nickname rules mirror the server; greetings use the nickname only when there is one and never
// fall back to the email address. Saving a nickname sends only the nickname to the account.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider, LOCALES, MESSAGES, type Locale } from "../src/i18n";
import { dayPart, personalize } from "../src/services/greeting";
import { normalizeNickname, preferredName, validateNickname } from "../src/services/profile";

let account: { email: string; nickname: string | null } | null = null;
const savePreferences = vi.fn(async (preferences: { nickname?: string }) => { if (account && preferences.nickname) account = { ...account, nickname: preferences.nickname }; });
vi.mock("../src/hooks/useAccount", () => ({
  useAccount: () => ({ account: account && { ...account, usageRegion: "US", registeredAt: null, locale: "en", timeZone: null, badges: [], ownerId: null }, offline: false, signOut: vi.fn(), savePreferences }),
}));
vi.mock("../src/hooks/useFinance", () => ({ useFinance: () => ({ store: {}, refresh: vi.fn(), rules: [] }) }));
const { GreetingHeader } = await import("../src/components/Greeting");
const { NicknamePrompt, isPromptSnoozed } = await import("../src/components/NicknamePrompt");
const { Settings } = await import("../src/pages/Settings");

const at = (hour: number, minute = 0) => new Date(2026, 10, 17, hour, minute);
const view = (node: React.ReactNode, locale: Locale = "en") => render(<I18nProvider initial={locale}>{node}</I18nProvider>);

beforeEach(() => { localStorage.clear(); savePreferences.mockClear(); account = { email: "jyun@example.com", nickname: "Jyun" }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("nickname rules (same as the server)", () => {
  it("requires a visible nickname, trims and collapses spaces, and allows up to 40 characters in any script", () => {
    expect(validateNickname("")).toBe("blank");
    expect(validateNickname(null)).toBe("blank");
    expect(validateNickname("   \t\n")).toBe("blank");
    expect(validateNickname("　　")).toBe("blank"); // ideographic spaces
    expect(validateNickname("​‍")).toBe("blank"); // zero-width characters only
    expect(validateNickname("a\u0007b")).toBe("invalid");
    expect(validateNickname("n".repeat(41))).toBe("too_long");
    expect(validateNickname("🌤".repeat(40))).toBeNull(); // counted like the server: one per character
    for (const name of ["小雨", "陳美玲", "ジュン", "김윤", "José María", "O'Brien-Smith", "Ana 🌤"]) expect(validateNickname(name), name).toBeNull();
    expect(normalizeNickname("  Sunny 　  Day ")).toBe("Sunny Day");
  });

  it("greets by nickname or not at all — never by email", () => {
    expect(preferredName({ nickname: " 小雨 " })).toBe("小雨");
    expect(preferredName({ nickname: null })).toBeNull();
    expect(preferredName({ nickname: "   " })).toBeNull();
    expect(preferredName(null)).toBeNull();
  });
});

describe("time of day", () => {
  it.each([[0, "evening"], [4, "evening"], [5, "morning"], [11, "morning"], [12, "afternoon"], [17, "afternoon"], [18, "evening"], [23, "evening"]])("%i:00 is %s", (hour, part) => {
    expect(dayPart(at(hour as number))).toBe(part);
    expect(dayPart(at(hour as number, 59))).toBe(part);
  });
});

describe("localized templates", () => {
  it.each(LOCALES)("%s: every named message places {name}; every plain one has no name", (locale) => {
    const visit = (node: unknown, path: string) => {
      if (node && typeof node === "object" && "named" in node && "plain" in node) {
        const { named, plain } = node as { named: string; plain: string };
        expect(named, path).toContain("{name}");
        expect(plain, path).not.toContain("{name}");
        expect(personalize({ named, plain }, null, { date: "Dec 3" })).toBe(plain.replace("{date}", "Dec 3"));
        return;
      }
      if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) visit(value, `${path}.${key}`);
    };
    visit(MESSAGES[locale].personal, "personal");
  });

  it("respects each language's word order and honorifics", () => {
    const morning = (locale: Locale) => personalize(MESSAGES[locale].personal.greeting.morning, "小雨");
    expect(morning("en")).toBe("Good morning, 小雨!");
    expect(morning("zh-CN")).toBe("早上好，小雨！");
    expect(morning("zh-TW")).toBe("早安，小雨！");
    expect(morning("ja")).toBe("小雨さん、おはようございます！");
    expect(morning("ko")).toBe("小雨님, 좋은 아침이에요!");
    expect(morning("es")).toBe("¡Buenos días, 小雨!");
  });
});

describe("dashboard greeting", () => {
  it.each([[8, "Good morning, Jyun!", "Let's see how your finances are looking today."], [14, "Good afternoon, Jyun!", "Here's your latest financial outlook."],
    [21, "Good evening, Jyun!", "Let's take a quick look at your financial weather."]])("at %i:00 greets by nickname", (hour, greeting, subtitle) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(hour as number));
    view(<GreetingHeader eyebrow="YOUR FINANCES, IN FOCUS" hasData needsAttention={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(greeting);
    expect(screen.getByText(subtitle as string)).toBeTruthy();
  });

  it("without a nickname it still greets warmly, and never shows the email", () => {
    account = { email: "jyun@example.com", nickname: null };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(9));
    const { container } = view(<GreetingHeader eyebrow="X" hasData={false} needsAttention={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning!");
    expect(screen.getByText("Ready to understand your financial weather?")).toBeTruthy();
    expect(container.textContent).not.toContain("jyun@example.com");
  });

  it("a new user is invited in; someone with uncategorized rows gets a gentle, non-judgmental note", () => {
    const { container } = view(<GreetingHeader eyebrow="X" hasData={false} needsAttention={false} />);
    expect(screen.getByText("Ready to understand your financial weather?")).toBeTruthy();
    expect(container.textContent!.split("Jyun").length - 1).toBe(1); // the name once, in the greeting
    cleanup();
    view(<GreetingHeader eyebrow="X" hasData needsAttention />);
    expect(screen.getByText(MESSAGES.en.personal.dashboard.attention)).toBeTruthy();
  });

  it("is localized (Japanese, Simplified Chinese)", () => {
    account = { email: "a@example.com", nickname: "小雨" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(19));
    view(<GreetingHeader eyebrow="X" hasData needsAttention={false} />, "ja");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("小雨さん、こんばんは！");
    cleanup();
    view(<GreetingHeader eyebrow="X" hasData needsAttention={false} />, "zh-CN");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("晚上好，小雨！");
  });

  it("the weather glyph is decorative (hidden from screen readers)", () => {
    const { container } = view(<GreetingHeader eyebrow="X" hasData needsAttention={false} />);
    expect(container.querySelector(".bw-greeting-glyph")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("nickname suggestion for existing accounts without one", () => {
  const nickname = () => screen.getByLabelText(/^Nickname/);

  it("is not shown when the account already has a nickname", () => {
    view(<NicknamePrompt ownerKey="id:1" />);
    expect(screen.queryByRole("heading", { name: MESSAGES.en.personal.nickname_prompt.title })).toBeNull();
  });

  it("rejects blank input locally, then saves only the trimmed nickname", async () => {
    account = { email: "old@example.com", nickname: null };
    const { rerender } = view(<NicknamePrompt ownerKey="id:1" />);
    expect(screen.getByRole("heading", { name: MESSAGES.en.personal.nickname_prompt.title })).toBeTruthy();
    fireEvent.change(nickname(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save nickname" }));
    expect(screen.getByText(MESSAGES.en.personal.nickname.errors.blank)).toBeTruthy();
    expect(nickname().getAttribute("aria-invalid")).toBe("true");
    expect(savePreferences).not.toHaveBeenCalled();

    fireEvent.change(nickname(), { target: { value: "  小雨  " } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save nickname" })); });
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith({ nickname: "小雨" });
    rerender(<I18nProvider initial="en"><NicknamePrompt ownerKey="id:1" /></I18nProvider>);
    expect(screen.getByRole("status").textContent).toBe("Nice to meet you, 小雨!");
  });

  it("“Maybe later” hides it on this device without saving anything", () => {
    account = { email: "old@example.com", nickname: null };
    view(<NicknamePrompt ownerKey="id:2" />);
    fireEvent.click(screen.getByRole("button", { name: "Maybe later" }));
    expect(screen.queryByRole("heading", { name: MESSAGES.en.personal.nickname_prompt.title })).toBeNull();
    expect(isPromptSnoozed("id:2")).toBe(true);
    expect(isPromptSnoozed("id:other")).toBe(false); // per account
    expect(savePreferences).not.toHaveBeenCalled();
    cleanup();
    view(<NicknamePrompt ownerKey="id:2" />);
    expect(screen.queryByRole("heading", { name: MESSAGES.en.personal.nickname_prompt.title })).toBeNull();
  });

  it("says so calmly when it can't save (offline)", async () => {
    account = { email: "old@example.com", nickname: null };
    savePreferences.mockRejectedValueOnce(new Error("offline"));
    view(<NicknamePrompt ownerKey="id:3" />);
    fireEvent.change(nickname(), { target: { value: "Sunny" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save nickname" })); });
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.en.personal.nickname_prompt.failed);
  });
});

describe("editing the nickname in Settings", () => {
  const field = () => screen.getByLabelText(/^Nickname/) as HTMLInputElement;

  it("can be changed to any language but not cleared", async () => {
    view(<Settings />);
    expect(field().value).toBe("Jyun");
    expect(field().required).toBe(true);
    fireEvent.change(field(), { target: { value: " " } });
    fireEvent.click(screen.getAllByRole("button", { name: MESSAGES.en.settings.save })[0]);
    expect(screen.getByText(MESSAGES.en.personal.nickname.errors.blank)).toBeTruthy();
    expect(savePreferences).not.toHaveBeenCalled();

    fireEvent.change(field(), { target: { value: "  김윤  " } });
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: MESSAGES.en.settings.save })[0]); });
    expect(savePreferences).toHaveBeenCalledExactlyOnceWith({ nickname: "김윤" });
  });
});

it.each(["saved", "saveFailed"] as const)("Settings shows %s in the newly selected language", async (result) => {
  if (result === "saveFailed") savePreferences.mockRejectedValueOnce(new Error("offline"));
  view(<Settings />);

  await act(async () => {
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
  });

  expect(savePreferences).toHaveBeenCalledExactlyOnceWith({ locale: "zh-CN" });
  expect(screen.getByRole("status").textContent).toBe(MESSAGES["zh-CN"].settings[result]);
});

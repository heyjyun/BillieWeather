// @vitest-environment jsdom
// Regression: the development quick sign-in shortcuts were removed from the shared login screen
// (used by the desktop builds on macOS and Windows and by the iOS/Android builds).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { I18nProvider, LOCALES, MESSAGES } from "../src/i18n";
import { Login } from "../src/pages/Login";
import { signIn as requestSignIn } from "../src/services/account";

const signIn = vi.fn();
vi.mock("../src/hooks/useAccount", () => ({ useAccount: () => ({ signIn }) }));

afterEach(() => { cleanup(); signIn.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(tsx?|css|json)$/.test(name) ? [path] : [];
  });
}

describe("login without quick sign-in", () => {
  it("shows only the standard email/password form, create-account and reset links", () => {
    render(<I18nProvider initial="en"><Login onCreateAccount={() => {}} /></I18nProvider>);
    expect(screen.getByLabelText(MESSAGES.en.login.email)).toBeTruthy();
    expect(screen.getByLabelText(MESSAGES.en.login.password)).toBeTruthy();
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual([MESSAGES.en.login.submit, MESSAGES.en.login.createAccount, MESSAGES.en.login.forgot]);
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/quick|heyjyun|example@example\.com|hello@hello\.com/i);
  });

  it("ignores leftover quick-login environment variables", () => {
    vi.stubEnv("VITE_QUICK_LOGIN_EXAMPLE_EMAIL", "example@example.com");
    vi.stubEnv("VITE_QUICK_LOGIN_EXAMPLE_PASSWORD", "example-pass");
    vi.stubEnv("VITE_QUICK_LOGIN_HEYJYUN_EMAIL", "me@example.com");
    vi.stubEnv("VITE_QUICK_LOGIN_HEYJYUN_PASSWORD", "my-pass");
    render(<I18nProvider initial="en"><Login /></I18nProvider>);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect((screen.getByLabelText(MESSAGES.en.login.email) as HTMLInputElement).value).toBe("");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("still signs in with the email and password the person typed", async () => {
    signIn.mockResolvedValue(undefined);
    render(<I18nProvider initial="en"><Login /></I18nProvider>);
    fireEvent.change(screen.getByLabelText(MESSAGES.en.login.email), { target: { value: "  person@example.org " } });
    fireEvent.change(screen.getByLabelText(MESSAGES.en.login.password), { target: { value: "typed-password" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.en.login.submit }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("person@example.org", "typed-password", undefined));
  });

  it("shows a localized server error when sign-in receives an HTML 500 response", async () => {
    signIn.mockImplementation(requestSignIn);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>Private server details</html>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    }));
    render(<I18nProvider initial="zh-CN"><Login initialEmail="person@example.org" /></I18nProvider>);
    fireEvent.change(screen.getByLabelText(MESSAGES["zh-CN"].login.password), { target: { value: "typed-password" } });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES["zh-CN"].login.submit }));
    expect((await screen.findByRole("alert")).textContent).toBe(MESSAGES["zh-CN"].login.errors.server_error);
  });

  it("has no quick sign-in strings in any interface language", () => {
    for (const locale of LOCALES) {
      expect((MESSAGES[locale].login as Record<string, unknown>).quick).toBeUndefined();
    }
  });

  it("ships no quick-login module, env variables or demo credentials in the shared sources", () => {
    const src = join(__dirname, "../src");
    expect(existsSync(join(src, "services/quickLogin.ts"))).toBe(false);
    for (const file of sourceFiles(src)) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/QUICK_LOGIN|quickLogin|heyjyun|example@example\.com|hello@hello\.com/);
    }
  });
});

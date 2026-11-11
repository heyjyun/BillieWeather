// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { I18nProvider, LOCALES, MESSAGES } from "../src/i18n";
import { Login } from "../src/pages/Login";

const signIn = vi.fn();
vi.mock("../src/hooks/useAccount", () => ({ useAccount: () => ({ signIn }) }));

const shortcuts = [
  { id: "example" as const, email: "example@example.com", password: "example-pass" },
  { id: "heyjyun" as const, email: "me@example.com", password: "my-pass" },
];

afterEach(() => { cleanup(); signIn.mockReset(); });

describe("quick sign-in", () => {
  it("signs in with the chosen shortcut's credentials in one tap", async () => {
    signIn.mockResolvedValue(undefined);
    render(<I18nProvider initial="zh-CN"><Login quickLogins={shortcuts} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: MESSAGES["zh-CN"].login.quick.heyjyun }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("me@example.com", "my-pass", undefined));
  });

  it("shows nothing when no shortcuts are configured", () => {
    render(<I18nProvider initial="en"><Login quickLogins={[]} /></I18nProvider>);
    expect(screen.queryByRole("group", { name: MESSAGES.en.login.quick.heading })).toBeNull();
  });

  it("is labelled in every interface language", () => {
    for (const locale of LOCALES) {
      const quick = MESSAGES[locale].login.quick;
      expect([quick.heading, quick.example, quick.heyjyun].every((text) => text.length > 0)).toBe(true);
    }
  });

  it("never ships credentials: only read from env, and only in dev builds", () => {
    const source = readFileSync(join(__dirname, "../src/services/quickLogin.ts"), "utf8");
    expect(source).toMatch(/import\.meta\.env\.DEV\s*\?/);
    expect(source).not.toMatch(/@\w+\.\w+/);
  });
});

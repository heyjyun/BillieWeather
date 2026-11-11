// @vitest-environment jsdom
// Appearance preferences (theme, collapsed sidebar) stay on this device: they change <html data-theme>
// and localStorage only, never the account or the network.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../src/i18n";
import { applyTheme, saveSidebarCollapsed, savedSidebarCollapsed, savedTheme, setTheme } from "../src/services/theme";

const savePreferences = vi.fn();
vi.mock("../src/hooks/useAccount", () => ({
  useAccount: () => ({ account: { email: "a@example.com", nickname: "", usageRegion: "US", registeredAt: null }, offline: false, signOut: vi.fn(), savePreferences }),
}));
vi.mock("../src/hooks/useFinance", () => ({ useFinance: () => ({ store: {}, refresh: vi.fn(), rules: [] }) }));
const { Settings } = await import("../src/pages/Settings");

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });
afterEach(cleanup);

describe("theme preference", () => {
  it("defaults to the system theme and ignores unknown stored values", () => {
    expect(savedTheme()).toBe("system");
    localStorage.setItem("billie.theme", "neon");
    expect(savedTheme()).toBe("system");
    applyTheme(savedTheme());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("forces light or dark and returns to the system setting", () => {
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("billie.theme")).toBe("dark");
    setTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("billie.theme")).toBeNull();
  });

  it("is chosen in Settings (Traditional Chinese) without saving anything to the account or network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<I18nProvider initial="zh-TW"><Settings /></I18nProvider>);
    const group = screen.getByRole("radiogroup", { name: "主題" });
    expect(screen.getByRole("radio", { name: "跟隨系統" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "淺色" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(group).toBeTruthy();
    expect(savePreferences).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sidebar preference", () => {
  it("remembers a collapsed sidebar on this device", () => {
    expect(savedSidebarCollapsed()).toBe(false);
    saveSidebarCollapsed(true);
    expect(savedSidebarCollapsed()).toBe(true);
    saveSidebarCollapsed(false);
    expect(localStorage.getItem("billie.sidebar")).toBeNull();
  });
});

/**
 * Appearance preferences kept on this device only (localStorage). Nothing here is reported,
 * synced or sent anywhere. The tokens stylesheet reads `<html data-theme>`; without it the
 * operating system's light/dark setting applies.
 */
export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "billie.theme";
const SIDEBAR_KEY = "billie.sidebar";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice lasts for this session only
  }
}

export function savedTheme(): ThemeChoice {
  const value = read(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function applyTheme(choice: ThemeChoice) {
  if (typeof document === "undefined") return;
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

export function setTheme(choice: ThemeChoice) {
  write(THEME_KEY, choice === "system" ? null : choice);
  applyTheme(choice);
}

export function savedSidebarCollapsed(): boolean {
  return read(SIDEBAR_KEY) === "collapsed";
}

export function saveSidebarCollapsed(collapsed: boolean) {
  write(SIDEBAR_KEY, collapsed ? "collapsed" : null);
}

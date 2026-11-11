// One-tap sign-in shortcuts for development only. Credentials come from clients/universal/.env.local
// (gitignored), never from source code, and only in `vite` dev builds: a release build
// (`npm run build` / `desktop:build`) folds `import.meta.env.DEV` to false and drops them entirely.
//
//   VITE_QUICK_LOGIN_EXAMPLE_EMAIL=...   VITE_QUICK_LOGIN_EXAMPLE_PASSWORD=...
//   VITE_QUICK_LOGIN_HEYJYUN_EMAIL=...   VITE_QUICK_LOGIN_HEYJYUN_PASSWORD=...
//
// To retire a shortcut, delete its lines from .env.local (the button disappears), or remove its
// entry below.

export interface QuickLogin {
  id: "example" | "heyjyun";
  email: string;
  password: string;
}

function entry(id: QuickLogin["id"], email: unknown, password: unknown): QuickLogin[] {
  const e = typeof email === "string" ? email.trim() : "";
  const p = typeof password === "string" ? password : "";
  return e && p ? [{ id, email: e, password: p }] : [];
}

export const QUICK_LOGINS: QuickLogin[] = import.meta.env.DEV
  ? [
      ...entry("example", import.meta.env.VITE_QUICK_LOGIN_EXAMPLE_EMAIL, import.meta.env.VITE_QUICK_LOGIN_EXAMPLE_PASSWORD),
      ...entry("heyjyun", import.meta.env.VITE_QUICK_LOGIN_HEYJYUN_EMAIL, import.meta.env.VITE_QUICK_LOGIN_HEYJYUN_PASSWORD),
    ]
  : [];

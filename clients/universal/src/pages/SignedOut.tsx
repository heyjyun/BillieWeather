// What a signed-out person sees: Sign In, or Create Account in the app (no website detour).
// Unmounted once someone signs in, so signing out later always starts again at Sign In.
import { useState } from "react";
import { Login } from "./Login";
import { Register } from "./Register";

export function SignedOut() {
  const [view, setView] = useState<{ page: "login" | "register"; email?: string }>({ page: "login" });
  if (view.page === "register") return <Register onBack={(email) => setView({ page: "login", email })} />;
  return <Login key={view.email ?? ""} initialEmail={view.email} onCreateAccount={() => setView({ page: "register" })} />;
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { installDropGuard } from "./services/dropGuard";
import { applyTheme, savedTheme } from "./services/theme";

applyTheme(savedTheme());
installDropGuard();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// Entry point of public/billie-command.js (built by scripts/build-web.mjs). The Rails layout renders
// an empty <div data-smart-command …> in the app's top bar; this mounts the command bar into it.
// Pages work without this file: it only adds the bar.

import { createRoot } from "react-dom/client";
import { commandEn, commandEs, commandJa, commandKo, commandZhCN, commandZhTW, type CommandMessages } from "../messages";
import "@nlae/react/commandBar.css";
import "./commandBar.web.css";
import { WebCommandBar } from "./WebCommandBar";

const STRINGS: Record<string, CommandMessages> = { en: commandEn, "zh-CN": commandZhCN, "zh-TW": commandZhTW, ja: commandJa, ko: commandKo, es: commandEs };

function mount(node: HTMLElement) {
  if (node.dataset.smartCommandReady) return;
  node.dataset.smartCommandReady = "1";
  const locale = node.dataset.locale ?? "en";
  const endpoints = { context: node.dataset.contextUrl!, preview: node.dataset.previewUrl!, execute: node.dataset.executeUrl!, undo: node.dataset.undoUrl! };
  const csrfToken = () => document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? null;
  createRoot(node).render(<WebCommandBar strings={STRINGS[locale] ?? commandEn} preferHan={locale === "zh-CN" || locale === "zh-TW"} endpoints={endpoints} csrfToken={csrfToken} />);
  node.hidden = false;
}

function start() {
  document.querySelectorAll<HTMLElement>("[data-smart-command]").forEach(mount);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

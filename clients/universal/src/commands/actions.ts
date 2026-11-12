// BillieWeather's capabilities for this app, from the shared definitions in @billie/commands (the
// same ones the website uses). Only the translations of built-in category names come from here.

import { categoryEntities as sharedCategoryEntities, LANGUAGE_OPTIONS, UNIVERSAL_PAGES, UNIVERSAL_PRODUCT, universalActions, universalRegistry } from "@billie/commands";
import type { ActionDefinition, EntityCandidate } from "@nlae/core";
import { MESSAGES } from "../i18n";
import type { Page } from "../App";

export const PRODUCT = UNIVERSAL_PRODUCT;
export { LANGUAGE_OPTIONS };

/** Every page the commands can open; typed so that each one must be a real page of this app. */
export const COMMAND_PAGES: readonly Page[] = UNIVERSAL_PAGES;

/** Built-in categories under every translated name; the person's own exactly as typed. */
export function categoryEntities(customCategories: readonly string[], label: (name: string) => string): EntityCandidate[] {
  return sharedCategoryEntities(customCategories, label, (name) => Object.values(MESSAGES).map((m) => (m.categories as Record<string, string>)[name]));
}

export const BILLIE_ACTIONS: ActionDefinition[] = universalActions();

export const billieRegistry = universalRegistry;

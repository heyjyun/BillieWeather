// BillieWeather's capabilities for this app, from the shared definitions in @billie/commands (the
// same ones the website uses). Only the translations of built-in category names come from here.

import { categoryEntities as sharedCategoryEntities, LANGUAGE_OPTIONS, UNIVERSAL_PAGES, UNIVERSAL_PRODUCT, universalActions, universalRegistry } from "@billie/commands";
import type { ActionDefinition, EntityCandidate } from "@nlae/core";
import { defaultCategoryByName } from "@billie/finance-core";
import { MESSAGES } from "../i18n";
import type { Page } from "../App";

export const PRODUCT = UNIVERSAL_PRODUCT;
export { LANGUAGE_OPTIONS };

/** Every page the commands can open; typed so that each one must be a real page of this app. */
export const COMMAND_PAGES: readonly Page[] = UNIVERSAL_PAGES;

/** Every category (default ones also under their name in every language); the person's own exactly as typed. */
export function categoryEntities(categories: readonly string[], label: (name: string) => string): EntityCandidate[] {
  return sharedCategoryEntities(categories, label, (name) => [
    ...Object.values(MESSAGES).map((m) => (m.categories as Record<string, string>)[name]),
    ...Object.values(defaultCategoryByName(name)?.labels ?? {}),
  ]);
}

export const BILLIE_ACTIONS: ActionDefinition[] = universalActions();

export const billieRegistry = universalRegistry;

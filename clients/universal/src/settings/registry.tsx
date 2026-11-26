// The Settings section registry. Settings (pages/Settings.tsx) is the app's configuration and
// management centre: it renders whatever is registered here, grouped by area, with an index. Add a
// section by adding an entry to SETTINGS_SECTIONS; nothing in Settings.tsx needs to change.
//
// - `area` groups sections; AREAS fixes the order of the groups.
// - `module` ties a section to a Feature Library module: it is listed while that module can be used
//   in the app (it is available), whether or not the module is in the sidebar.
// - `needsShell` sections link to other pages; they are left out when Settings is rendered on its own
//   (tests, previews) without the app shell's navigation.
//
// The website keeps the same areas in app/models/finance/settings_sections.rb.
import { isModuleEnabled, type ModuleId } from "@billie/shared-types";
import type { ReactNode } from "react";
import type { Page, TransactionIntent } from "../App";
import type { ModuleDefinition } from "@billie/shared-types";
import { AccountSection, AppearanceSection, RulesSection } from "./accountSections";
import { DataSection, DatabaseSection, SyncSection } from "./dataSections";
import { AutomationSection, FeatureLibrarySection, ModuleSettingsSection } from "./featureSections";

export type SettingsArea = "features" | "database" | "data" | "sync" | "account" | "appearance" | "rules" | "modules";
export const AREAS: readonly SettingsArea[] = ["features", "database", "data", "sync", "account", "appearance", "rules", "modules"];

export type Go = (page: Page, part?: string | null, filter?: undefined, intent?: TransactionIntent) => void;

export interface SettingsShell {
  go: Go;
  openModule: (module: ModuleDefinition) => void;
}

export interface SectionProps {
  /** The app shell's navigation; absent when Settings is rendered on its own. */
  shell: SettingsShell | null;
}

export interface SettingsSection {
  id: string;
  area: SettingsArea;
  module?: ModuleId;
  needsShell?: boolean;
  render: (props: SectionProps) => ReactNode;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "feature-library", area: "features", render: (props) => <FeatureLibrarySection {...props} /> },
  { id: "database", area: "database", render: (props) => <DatabaseSection {...props} /> },
  { id: "data", area: "data", needsShell: true, render: (props) => <DataSection {...props} /> },
  { id: "sync", area: "sync", render: (props) => <SyncSection {...props} /> },
  { id: "account", area: "account", render: () => <AccountSection /> },
  { id: "appearance", area: "appearance", render: () => <AppearanceSection /> },
  { id: "automation", area: "rules", needsShell: true, render: (props) => <AutomationSection {...props} /> },
  { id: "rules", area: "rules", render: (props) => <RulesSection {...props} /> },
  { id: "module-accounts", area: "modules", module: "accounts", needsShell: true, render: (props) => <ModuleSettingsSection {...props} module="accounts" /> },
  { id: "module-categories", area: "modules", module: "categories", needsShell: true, render: (props) => <ModuleSettingsSection {...props} module="categories" /> },
  { id: "module-budgets", area: "modules", module: "budgets", needsShell: true, render: (props) => <ModuleSettingsSection {...props} module="budgets" /> },
  { id: "module-recurring", area: "modules", module: "recurring", needsShell: true, render: (props) => <ModuleSettingsSection {...props} module="recurring" /> },
];

/** The sections to show, grouped by area in AREAS order; empty areas are left out. */
export function visibleSections(hasShell: boolean, sections: readonly SettingsSection[] = SETTINGS_SECTIONS): Array<{ area: SettingsArea; sections: SettingsSection[] }> {
  const shown = sections.filter((section) => (hasShell || !section.needsShell) && (!section.module || isModuleEnabled(section.module, "app")));
  return AREAS.map((area) => ({ area, sections: shown.filter((section) => section.area === area) })).filter((group) => group.sections.length > 0);
}

export const areaAnchor = (area: SettingsArea) => `settings-area-${area}`;

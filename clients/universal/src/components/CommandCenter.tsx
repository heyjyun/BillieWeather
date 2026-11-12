// The typed command bar at the top of every page. Parsing, previews and execution all run on this
// device (offline); data changes go through the same FinanceStore methods the pages use and are
// always previewed and confirmed first. One session per signed-in account and database: switching
// either starts over, so no plan, history or undo crosses databases.

import { ActionExecutor, DialogueSession, NaturalLanguageEngine } from "@nlae/core";
import { translateCommandMessage } from "@billie/commands";
import { CommandBar, createLocalController, type CommandBarLabels } from "@nlae/react";
import "@nlae/react/commandBar.css";
import { useMemo, useRef } from "react";
import type { Page } from "../App";
import { billieRegistry, PRODUCT } from "../commands/actions";
import { createAuthorizer, createEntities, createHandlers, type TransactionFilter } from "../commands/handlers";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, isLocale, MESSAGES, useI18n } from "../i18n";
import { setTheme } from "../services/theme";

/** Translates an engine or host message by code (shared with the website). */
export { translateCommandMessage };

export function CommandCenter({ go }: { go: (page: Page, part?: string | null, filter?: TransactionFilter) => void }) {
  const { m, locale, setLocale } = useI18n();
  const { account } = useAccount();
  const finance = useFinance();
  // Handlers read the latest data and callbacks through refs: the engine is built once per database.
  const latest = useRef({ finance, m, go, setLocale });
  latest.current = { finance, m, go, setLocale };
  const principal = account?.email ?? null;
  const tenant = `${principal ?? ""}#${finance.activeDatabaseId}`;
  const store = finance.store;

  const controller = useMemo(() => {
    const deps = {
      store,
      data: () => latest.current.finance,
      refresh: () => latest.current.finance.refresh(),
      navigate: (page: Page, filter?: TransactionFilter) => latest.current.go(page, null, filter),
      setLanguage: (next: string) => { if (isLocale(next)) latest.current.setLocale(next); },
      setTheme,
      categoryLabel: (name: string) => categoryLabel(latest.current.m, name),
    };
    const registry = billieRegistry();
    const entities = createEntities(deps);
    const engine = new NaturalLanguageEngine(registry, entities);
    const executor = new ActionExecutor({ registry, entities, authorizer: createAuthorizer(), handlers: createHandlers(deps) });
    return createLocalController({
      session: new DialogueSession(engine),
      executor,
      entities,
      parseContext: () => ({ product: PRODUCT, tenant, now: new Date(), defaultCurrency: latest.current.finance.currency }),
      executionContext: () => ({ product: PRODUCT, tenant, principal, now: new Date() }),
      preferHan: () => locale === "zh-CN" || locale === "zh-TW",
    });
    // A new account or database gets a new session, executor, idempotency and undo store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, tenant, principal]);

  const c = m.command;
  const actionName = (id: string) => (c.actions as Record<string, string>)[id.replace(".", "_")] ?? id;
  const labels: CommandBarLabels = c.labels;
  return (
    <div className="bw-command">
      <CommandBar
        controller={controller}
        labels={labels}
        format={(message) => translateCommandMessage(c, m.nav as unknown as Record<string, string>, actionName, message)}
        actionName={actionName}
        paramName={(_id, param) => (c.params as Record<string, string>)[param] ?? param}
        valueLabel={(_id, param, value, fallback) => {
          if (param === "category" || param === "from" || param === "target") return categoryLabel(m, value);
          if (param === "page") return (m.nav as unknown as Record<string, string>)[value] ?? fallback;
          if (param === "theme") return (c.themes as Record<string, string>)[value] ?? fallback;
          if (param === "language") return isLocale(value) ? MESSAGES[value].languageName : fallback;
          return fallback;
        }}
      />
    </div>
  );
}

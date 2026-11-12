// The website's command bar: the same @nlae/react CommandBar and strings as the universal client,
// wired to the Rails trusted executor through the remote controller.

import type { ActionPlan, ExecutionResult } from "@nlae/core";
import { CommandBar } from "@nlae/react";
import { useEffect, useMemo, useState } from "react";
import { webRegistry } from "../actions";
import { commandEn, type CommandMessages } from "../messages";
import { commandActionName, translateCommandMessage } from "../translate";
import { CommandNetworkError, createRemoteController, type RemoteController, type WebCommandContext, type WebEndpoints } from "./remoteController";

/** Commands whose successful result changes what the current page shows. */
const WRITES = new Set(["transactions.categorize", "transactions.exclude", "transactions.include", "categories.create", "categories.rename"]);

export interface WebCommandBarProps {
  strings: CommandMessages;
  /** Simplified/Traditional Chinese interface: suggest Chinese examples first. */
  preferHan: boolean;
  endpoints: WebEndpoints;
  csrfToken: () => string | null;
  /** Leaves the page (navigation and search results). Replaceable in tests. */
  navigate?: (url: string) => void;
  reload?: () => void;
  fetch?: typeof fetch;
  /** For tests: a ready controller. */
  controller?: RemoteController;
}

const redirectOf = (result: ExecutionResult): string | null => {
  const data = result.data as { redirect?: unknown } | undefined;
  // Only same-site paths from the trusted side; never a full URL.
  return typeof data?.redirect === "string" && /^\/(?!\/)/.test(data.redirect) ? data.redirect : null;
};

export function WebCommandBar(props: WebCommandBarProps) {
  const c = props.strings;
  const [context, setContext] = useState<WebCommandContext | null>(null);
  const [changed, setChanged] = useState(false);
  const navigate = props.navigate ?? ((url: string) => window.location.assign(url));

  const controller = useMemo(() => props.controller ?? createRemoteController({
    registry: webRegistry(),
    endpoints: props.endpoints,
    csrfToken: props.csrfToken,
    fetch: props.fetch,
    preferHan: () => props.preferHan,
    onResult(result: ExecutionResult, plan: ActionPlan) {
      if (result.status !== "succeeded") return;
      const redirect = redirectOf(result);
      if (redirect) navigate(redirect);
      else if (plan.intent && WRITES.has(plan.intent.actionId) && !result.replayed) setChanged(true);
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load category names on first use only, so pages that never use the bar make no extra request.
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (!wanted || context) return;
    let live = true;
    controller.context().then((value) => { if (live) setContext(value); }, () => undefined);
    return () => { live = false; };
  }, [wanted, context, controller]);

  // Transport problems become a readable status line (the bar shows thrown messages) instead of a crash.
  const guarded = useMemo<RemoteController>(() => {
    const wrap = <A extends unknown[], R>(work: (...args: A) => Promise<R>) => (...args: A) => work(...args).catch((error: unknown) => { throw new Error(networkMessage(c, error)); });
    return { ...controller, submit: wrap(controller.submit), edit: wrap(controller.edit), preview: wrap(controller.preview), execute: wrap(controller.execute), undo: wrap(controller.undo) };
  }, [controller, c]);

  const actionName = commandActionName(c);
  const pages = context?.pages ?? {};
  const categoryLabel = (id: string) => context?.builtInCategories.find((b) => b.id === id)?.label ?? id;
  const format = (message: Parameters<typeof translateCommandMessage>[3]) => {
    const vars = message.vars && typeof message.vars.category === "string" ? { ...message.vars, category: categoryLabel(message.vars.category) } : message.vars;
    return translateCommandMessage(c, pages, actionName, { ...message, vars });
  };

  return (
    <div className="bw-command-inner" onFocusCapture={() => setWanted(true)} onPointerEnter={() => setWanted(true)}>
      <CommandBar
        controller={guarded}
        labels={c.labels}
        format={format}
        actionName={actionName}
        paramName={(_id, param) => (c.params as Record<string, string>)[param] ?? param}
        valueLabel={(_id, param, value, fallback) => {
          if (param === "category" || param === "from" || param === "target") return categoryLabel(value);
          if (param === "page") return pages[value] ?? fallback;
          return fallback;
        }}
      />
      {changed && (
        <p className="bw-command-refresh" role="status">
          <span>{c.messages.page_outdated}</span>
          <button type="button" className="nlae-button" onClick={() => (props.reload ?? (() => window.location.reload()))()}>{c.messages.refresh}</button>
        </p>
      )}
    </div>
  );
}

function networkMessage(c: CommandMessages, error: unknown): string {
  if (error instanceof CommandNetworkError) return error.status === 401 ? c.messages.unauthenticated : c.messages.network_error;
  return c.messages.handler_error;
}

/** English strings, for hosts that have not loaded a locale. */
export const DEFAULT_WEB_STRINGS = commandEn;

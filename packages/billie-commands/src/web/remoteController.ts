// The website's command controller. Parsing, suggestions, clarifications and preview edits run in
// the browser with the shared engine (no network, no LLM). Previews, execution and undo go to the
// Rails trusted executor, which validates everything again against the user's own data.
//
// Nothing financial is sent to parse a command: the browser only receives the category names it
// needs to understand them (GET context), and only sends a plan when the person runs a command.

import {
  DialogueSession, NaturalLanguageEngine, PROTOCOL_VERSION, type ActionPlan, type ActionRegistry, type EntityCandidate, type EntityProvider, type ExecutionResult,
  type ParseContext, type PreviewResult,
} from "@nlae/core";
import type { CommandController } from "@nlae/react";
import { categoryEntities } from "../actions";

/** What GET /app/command/context returns. Category names only: no transactions, amounts or balances. */
export interface WebCommandContext {
  product: string;
  tenant: string;
  /** The person's local date (YYYY-MM-DD), so "this month" means the same as on the website's pages. */
  today: string;
  currency: string | null;
  /** Built-in categories: the name shown in the current language, and the names in every language. */
  builtInCategories: Array<{ id: string; label: string; names: string[] }>;
  customCategories: string[];
  /** Page labels in the current language, by navigate value. */
  pages: Record<string, string>;
}

export interface WebEndpoints {
  context: string;
  preview: string;
  execute: string;
  undo: string;
}

/** A request that never reached the trusted side, or came back unreadable. */
export class CommandNetworkError extends Error {
  constructor(readonly status: number | null) {
    super(`command request failed${status ? ` (${status})` : ""}`);
    this.name = "CommandNetworkError";
  }
}

export interface RemoteControllerOptions {
  registry: ActionRegistry;
  endpoints: WebEndpoints;
  csrfToken: () => string | null;
  fetch?: typeof fetch;
  preferHan?: () => boolean;
  /** Called with every result from the trusted side (navigation, "data changed"). */
  onResult?: (result: ExecutionResult, plan: ActionPlan) => void;
}

export interface RemoteController extends CommandController {
  /** Loads (once) and returns the context; rejects with CommandNetworkError. */
  context(): Promise<WebCommandContext>;
}

export function createRemoteController(options: RemoteControllerOptions): RemoteController {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let loaded: WebCommandContext | null = null;
  let loading: Promise<WebCommandContext> | null = null;

  const request = async <T>(url: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": options.csrfToken() ?? "" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CommandNetworkError(null);
    }
    // The executor answers rejections with 200 and a typed result; anything else is transport-level.
    if (!response.ok) throw new CommandNetworkError(response.status);
    try {
      return (await response.json()) as T;
    } catch {
      throw new CommandNetworkError(response.status);
    }
  };

  const context = () => {
    if (loaded) return Promise.resolve(loaded);
    loading ??= request<WebCommandContext>(options.endpoints.context).then((value) => (loaded = value)).finally(() => { loading = null; });
    return loading;
  };

  const entities: EntityProvider = {
    list(kind): readonly EntityCandidate[] {
      if (!loaded) return [];
      if (kind === "category") {
        const byId = new Map(loaded.builtInCategories.map((c) => [c.id, c]));
        return categoryEntities(loaded.customCategories, (name) => byId.get(name)?.label ?? name, (name) => byId.get(name)?.names ?? []);
      }
      if (kind === "customCategory") return loaded.customCategories.map((name) => ({ id: name, label: name }));
      return [];
    },
  };

  const engine = new NaturalLanguageEngine(options.registry, entities);
  const session = new DialogueSession(engine);
  const parseContext = async (): Promise<ParseContext> => {
    const ctx = await context();
    return { product: ctx.product, tenant: ctx.tenant, today: ctx.today, now: new Date(), defaultCurrency: ctx.currency };
  };

  const report = (result: ExecutionResult, plan: ActionPlan) => {
    options.onResult?.(result, plan);
    return result;
  };

  return {
    context,
    suggest: (text) => engine.suggest(text, { limit: 6, preferHan: options.preferHan?.() }),
    submit: async (text) => session.submit(text, await parseContext()),
    edit: async (plan, edits) => session.edit(plan, edits, await parseContext()),
    preview: (plan) => request<PreviewResult>(options.endpoints.preview, { protocol: PROTOCOL_VERSION, plan }),
    // The plan id is the idempotency key: a repeated click or a retried request runs the change once.
    execute: async (plan, confirmation) => report(await request<ExecutionResult>(options.endpoints.execute, { protocol: PROTOCOL_VERSION, plan, confirmation, idempotencyKey: plan.planId }), plan),
    undo: (token) => request<ExecutionResult>(options.endpoints.undo, { protocol: PROTOCOL_VERSION, token }),
    remember: (plan) => session.remember(plan),
    reset: () => session.reset(),
    definition: (id) => options.registry.get(id),
    async options(plan, param) {
      const definition = plan.intent && options.registry.get(plan.intent.actionId);
      const spec = definition?.params.find((p) => p.name === param);
      if (!spec) return [];
      if (spec.type === "enum" || spec.type === "boolean") return (spec.options ?? []).map((o) => ({ value: o.value, label: o.value }));
      if (spec.type === "entity") {
        await context();
        return (await entities.list(spec.entityKind!, { product: options.registry.product, tenant: loaded!.tenant })).map((e) => ({ value: e.id, label: e.label }));
      }
      return [];
    },
  };
}

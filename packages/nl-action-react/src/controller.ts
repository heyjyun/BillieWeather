// What the command bar needs from a host. In-process hosts use `createLocalController`; hosts with a
// remote trusted side implement `preview`, `execute` and `undo` as calls to their own API, sending
// the same JSON (see @nlae/core schema/).

import type {
  ActionDefinition, ActionExecutor, ActionPlan, ArgumentValue, ClarificationOption, DialogueSession, EntityProvider, ExecutionContext, ExecutionResult,
  ParseContext, PreviewResult, Suggestion,
} from "@nlae/core";
import { PROTOCOL_VERSION } from "@nlae/core";

export interface CommandController {
  suggest(text: string): Suggestion[];
  submit(text: string): Promise<ActionPlan>;
  edit(plan: ActionPlan, edits: Record<string, ArgumentValue | null>): Promise<ActionPlan>;
  preview(plan: ActionPlan): Promise<PreviewResult>;
  execute(plan: ActionPlan, confirmation: { confirmed: boolean; typed?: string }): Promise<ExecutionResult>;
  undo(token: string): Promise<ExecutionResult>;
  /** Keeps a completed plan for follow-up references ("…them"). */
  remember(plan: ActionPlan): void;
  /** Cancels any open question. */
  reset(): void;
  definition(actionId: string): ActionDefinition | undefined;
  /** Choices for an editable enum/entity parameter in the preview. */
  options(plan: ActionPlan, param: string): Promise<ClarificationOption[]>;
}

export interface LocalControllerOptions {
  session: DialogueSession;
  executor: ActionExecutor;
  entities: EntityProvider;
  parseContext: () => ParseContext;
  executionContext: () => ExecutionContext;
  /** Prefer Chinese example commands when the input box is empty. */
  preferHan?: () => boolean;
}

export function createLocalController(options: LocalControllerOptions): CommandController {
  const { session, executor } = options;
  return {
    suggest: (text) => session.engine.suggest(text, { limit: 6, preferHan: options.preferHan?.() }),
    submit: (text) => session.submit(text, options.parseContext()),
    edit: (plan, edits) => session.edit(plan, edits, options.parseContext()),
    preview: (plan) => executor.preview(plan, options.executionContext()),
    execute: (plan, confirmation) => executor.execute({ protocol: PROTOCOL_VERSION, plan, confirmation }, options.executionContext()),
    undo: (token) => executor.undo(token, options.executionContext()),
    remember: (plan) => session.remember(plan),
    reset: () => session.reset(),
    definition: (id) => session.engine.registry.get(id),
    async options(plan, param) {
      const definition = plan.intent && session.engine.registry.get(plan.intent.actionId);
      const spec = definition?.params.find((p) => p.name === param);
      if (!spec) return [];
      if (spec.type === "enum" || spec.type === "boolean") return (spec.options ?? []).map((o) => ({ value: o.value, label: o.value }));
      if (spec.type === "entity") {
        const ctx = options.parseContext();
        return (await options.entities.list(spec.entityKind!, { product: ctx.product, tenant: ctx.tenant })).map((e) => ({ value: e.id, label: e.label }));
      }
      return [];
    },
  };
}

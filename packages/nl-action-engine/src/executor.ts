// The trusted side. A plan is a request, not an instruction: everything is checked again here —
// shape, protocol, isolation scope, authorization, arguments, confirmation and preview freshness —
// before the host's handler runs. Repeated submissions are idempotent.

import type { ActionArguments, ActionHandler, Authorizer, EntityCandidate, EntityProvider, ExecutionContext } from "./adapter";
import {
  confirmationFor, PROTOCOL_VERSION, type ActionDefinition, type ActionPlan, type ExecutionRequest, type ExecutionResult, type Message, type PreviewResult,
  type ProposedOperation, type RejectionCode,
} from "./protocol";
import type { ActionRegistry } from "./registry";
import { fingerprint, planShapeProblem, sameTypedPhrase, validateArguments } from "./validate";

/** Completed results by idempotency key. Hosts with a database should persist these. */
export interface IdempotencyStore {
  get(key: string): Promise<ExecutionResult | undefined> | ExecutionResult | undefined;
  set(key: string, result: ExecutionResult): Promise<void> | void;
}

export interface UndoRecord {
  product: string;
  tenant: string;
  actionId: string;
  payload: unknown;
  expiresAt: number;
}

export interface UndoStore {
  take(token: string): Promise<UndoRecord | undefined> | UndoRecord | undefined;
  put(token: string, record: UndoRecord): Promise<void> | void;
}

/** Bounded in-memory stores (per process). */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { result: ExecutionResult; at: number }>();
  constructor(private readonly max = 500, private readonly ttlMs = 24 * 3_600_000, private readonly clock = () => Date.now()) {}
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.clock() - entry.at > this.ttlMs) { this.entries.delete(key); return undefined; }
    return entry.result;
  }
  set(key: string, result: ExecutionResult) {
    this.entries.set(key, { result, at: this.clock() });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

export class MemoryUndoStore implements UndoStore {
  private readonly entries = new Map<string, UndoRecord>();
  constructor(private readonly max = 100) {}
  take(token: string) {
    const record = this.entries.get(token);
    this.entries.delete(token);
    return record;
  }
  put(token: string, record: UndoRecord) {
    this.entries.set(token, record);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

export interface ExecutorOptions {
  registry: ActionRegistry;
  handlers: Record<string, ActionHandler>;
  entities: EntityProvider;
  authorizer: Authorizer;
  idempotency?: IdempotencyStore;
  undo?: UndoStore;
  /** How long an undo stays available. */
  undoTtlMs?: number;
  tokenFactory?: () => string;
}

class Rejection extends Error {
  constructor(readonly code: RejectionCode, readonly summary: Message) {
    super(summary.message);
  }
}

const reject = (code: RejectionCode, message: string, vars?: Record<string, string | number>): never => { throw new Rejection(code, { code, message, ...(vars ? { vars } : {}) }); };

/** The handler may explain why nothing would change ("already exists", "nothing matches"). */
const noEffect = (summary?: Message): never => { throw new Rejection("no_effect", summary ?? { code: "no_effect", message: "Nothing would change." }); };

const randomToken = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export class ActionExecutor {
  private readonly inFlight = new Map<string, Promise<ExecutionResult>>();
  private readonly idempotency: IdempotencyStore;
  private readonly undoStore: UndoStore;

  constructor(private readonly options: ExecutorOptions) {
    for (const definition of options.registry.all()) {
      if (!options.handlers[definition.id]) throw new Error(`no handler for ${definition.id}`);
      if (definition.undoable && !options.handlers[definition.id].undo) throw new Error(`${definition.id} is undoable but its handler has no undo`);
    }
    this.idempotency = options.idempotency ?? new MemoryIdempotencyStore();
    this.undoStore = options.undo ?? new MemoryUndoStore();
  }

  /** Computes the concrete operations (no writes) and fingerprints them for execution. */
  async preview(plan: ActionPlan, ctx: ExecutionContext): Promise<PreviewResult> {
    try {
      const { definition, args, handler } = await this.admit(plan, ctx);
      const prepared = await handler.prepare(args, ctx);
      if (!prepared.operations.length && definition.risk !== "none") noEffect(prepared.summary);
      return { ok: true, plan: { ...plan, operations: prepared.operations, fingerprint: fingerprint(prepared.operations), confirmation: confirmationFor(definition) } };
    } catch (error) {
      if (error instanceof Rejection) return { ok: false, plan, rejection: { code: error.code, summary: error.summary } };
      throw error;
    }
  }

  async execute(request: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult> {
    const plan = request?.plan;
    const planId = typeof plan?.planId === "string" ? plan.planId : "unknown";
    const key = `${ctx.product}\u0000${ctx.tenant}\u0000${request?.idempotencyKey ?? planId}`;
    const stored = await this.idempotency.get(key);
    if (stored) return { ...stored, replayed: true };
    const running = this.inFlight.get(key);
    if (running) return { ...(await running), replayed: true };
    const work = this.run(request, ctx).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    const result = await work;
    // Only completed executions are remembered: a rejected or failed request may be retried.
    if (result.status === "succeeded") await this.idempotency.set(key, result);
    return result;
  }

  async undo(token: string, ctx: ExecutionContext): Promise<ExecutionResult> {
    const base = { protocol: PROTOCOL_VERSION, planId: "undo", replayed: false, operations: [] as ProposedOperation[] };
    const record = typeof token === "string" ? await this.undoStore.take(token) : undefined;
    if (!record) return { ...base, status: "rejected", code: "undo_unavailable", summary: { code: "undo_unavailable", message: "There is nothing to undo." } };
    if (record.product !== ctx.product || record.tenant !== ctx.tenant) {
      await this.undoStore.put(token, record); // not yours: leave it for its owner
      return { ...base, status: "rejected", code: "scope_mismatch", summary: { code: "scope_mismatch", message: "This undo belongs to another workspace." } };
    }
    if (ctx.now.getTime() > record.expiresAt) return { ...base, status: "rejected", code: "undo_expired", summary: { code: "undo_expired", message: "It is too late to undo this." } };
    const handler = this.options.handlers[record.actionId];
    try {
      const summary = await handler.undo!(record.payload, ctx);
      return { ...base, status: "succeeded", summary };
    } catch (error) {
      await this.undoStore.put(token, record); // keep it so the person can retry
      return { ...base, status: "failed", code: "handler_error", summary: { code: "undo_failed", message: error instanceof Error ? error.message : "Undo failed." } };
    }
  }

  private async run(request: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult> {
    const plan = request?.plan;
    const result = (status: ExecutionResult["status"], summary: Message, extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
      protocol: PROTOCOL_VERSION, planId: typeof plan?.planId === "string" ? plan.planId : "unknown", status, summary, replayed: false, operations: [], ...extra,
    });
    let definition: ActionDefinition;
    let args: ActionArguments;
    let handler: ActionHandler;
    let entitiesByKind: Record<string, readonly EntityCandidate[]>;
    let operations: ProposedOperation[];
    let prepared;
    try {
      if (request?.protocol !== PROTOCOL_VERSION) reject("protocol_mismatch", "Unsupported protocol version.");
      ({ definition, args, handler, entitiesByKind } = await this.admit(plan, ctx));
      const level = confirmationFor(definition);
      if (level !== "none" && request.confirmation?.confirmed !== true) reject("confirmation_required", "Please confirm this action first.");
      if (level === "typed") {
        const phrase = this.typedPhrase(definition, args, entitiesByKind);
        if (!sameTypedPhrase(phrase, request.confirmation?.typed)) reject("typed_confirmation_mismatch", `Type "${phrase}" to confirm.`, { phrase });
      }
      prepared = await handler.prepare(args, ctx);
      operations = prepared.operations;
      if (!operations.length && definition.risk !== "none") noEffect(prepared.summary);
      // Data-changing plans must have been previewed, and the data must not have changed since.
      if (definition.risk !== "none" && plan.fingerprint !== fingerprint(operations)) reject("stale_preview", "The data changed since the preview. Review the updated preview.");
    } catch (error) {
      if (error instanceof Rejection) return result("rejected", error.summary, { code: error.code });
      throw error;
    }
    try {
      const outcome = await handler.execute(prepared, args, ctx);
      let undo: ExecutionResult["undo"] = null;
      if (definition.undoable && outcome.undo !== undefined) {
        const token = (this.options.tokenFactory ?? randomToken)();
        const expiresAt = ctx.now.getTime() + (this.options.undoTtlMs ?? 10 * 60_000);
        await this.undoStore.put(token, { product: ctx.product, tenant: ctx.tenant, actionId: definition.id, payload: outcome.undo, expiresAt });
        undo = { token, expiresAt: new Date(expiresAt).toISOString() };
      }
      return result("succeeded", outcome.summary, { data: outcome.data, undo, operations });
    } catch (error) {
      return result("failed", { code: "handler_error", message: error instanceof Error ? error.message : "The action failed." }, { code: "handler_error", operations });
    }
  }

  /** Shape, protocol, readiness, scope, action, authorization and argument checks. */
  private async admit(plan: ActionPlan, ctx: ExecutionContext): Promise<{ definition: ActionDefinition; args: ActionArguments; handler: ActionHandler; entitiesByKind: Record<string, readonly EntityCandidate[]> }> {
    const shape = planShapeProblem(plan);
    if (shape === "protocol") reject("protocol_mismatch", "Unsupported protocol version.");
    if (shape) reject("malformed_plan", `The plan is malformed (${shape}).`);
    if (plan.status !== "ready" || !plan.intent) reject("not_ready", "This plan still needs an answer before it can run.");
    if (plan.scope.product !== ctx.product || plan.scope.tenant !== ctx.tenant || plan.scope.product !== this.options.registry.product) {
      reject("scope_mismatch", "This plan was made for another workspace.");
    }
    const definition = this.options.registry.get(plan.intent!.actionId);
    if (!definition) reject("unknown_action", "That action is not available.");
    const args: ActionArguments = {};
    for (const [name, argument] of Object.entries(plan.arguments)) args[name] = argument.value;
    const entitiesByKind: Record<string, readonly EntityCandidate[]> = {};
    for (const spec of definition!.params) {
      if (spec.entityKind && !(spec.entityKind in entitiesByKind)) entitiesByKind[spec.entityKind] = await this.options.entities.list(spec.entityKind, { product: ctx.product, tenant: ctx.tenant });
    }
    const issues = validateArguments(definition!, args, entitiesByKind);
    if (issues.length) reject("invalid_arguments", issues.map((i) => i.message).join("; "));
    const decision = await this.options.authorizer.authorize({ plan, definition: definition!, args, ctx });
    if (!decision.allowed) reject(decision.code, decision.message);
    return { definition: definition!, args, handler: this.options.handlers[definition!.id], entitiesByKind };
  }

  /** Recomputed here from the trusted entity list, never taken from the plan. */
  private typedPhrase(definition: ActionDefinition, args: ActionArguments, entitiesByKind: Record<string, readonly EntityCandidate[]>): string {
    const param = definition.typedConfirmationParam;
    if (!param) return "CONFIRM";
    const value = args[param];
    const spec = definition.params.find((p) => p.name === param);
    if (spec?.entityKind) return entitiesByKind[spec.entityKind]?.find((e) => e.id === value)?.label ?? "CONFIRM";
    return typeof value === "string" ? value : "CONFIRM";
  }
}

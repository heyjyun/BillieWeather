// The typed boundary between the engine and a host application. The engine knows nothing about
// the host's business concepts: everything domain-specific arrives through these interfaces.

import type { ActionDefinition, ActionPlan, ArgumentValue, Message, ProposedOperation, RegistryManifest } from "./protocol";

export interface EntityCandidate {
  id: string;
  /** Shown to the person; also matched. */
  label: string;
  /** Other names, translations, abbreviations. */
  aliases?: string[];
}

/** Lists the things commands can refer to (documents, contacts, folders…), for one tenant. */
export interface EntityProvider {
  list(kind: string, scope: { product: string; tenant: string }): Promise<readonly EntityCandidate[]> | readonly EntityCandidate[];
}

export interface ContextValue {
  value: ArgumentValue;
  display?: string;
}

/** What the parser may know about the person's situation. Never used for authorization. */
export interface ParseContext {
  product: string;
  tenant: string;
  now?: Date;
  /** Local calendar date (YYYY-MM-DD) for relative dates; defaults to `now` in local time. */
  today?: string;
  defaultCurrency?: string | null;
  /** Host focus by context key (the open record, the current filter). */
  focus?: Record<string, ContextValue>;
}

/** The trusted side's view of who is acting. Hosts build it from their own session. */
export interface ExecutionContext {
  product: string;
  tenant: string;
  /** Authenticated principal, null when nobody is signed in. */
  principal: string | null;
  now: Date;
  locale?: string;
}

export type ActionArguments = Record<string, ArgumentValue>;

export interface PreparedExecution<P = unknown> {
  operations: ProposedOperation[];
  /** Trusted-side working data passed to `execute`; never leaves the trusted side. */
  payload?: P;
  /** Optional message for the preview (e.g. "12 records will change"). */
  summary?: Message;
}

export interface HandlerOutcome {
  summary: Message;
  data?: unknown;
  /** Data needed to undo or compensate; present only when undo is possible. */
  undo?: unknown;
}

/**
 * Executes one action against the host's business services. `prepare` must not write. `execute`
 * must apply all operations or none (use a database transaction or compensate on failure).
 */
export interface ActionHandler<P = unknown> {
  prepare(args: ActionArguments, ctx: ExecutionContext): Promise<PreparedExecution<P>>;
  execute(prepared: PreparedExecution<P>, args: ActionArguments, ctx: ExecutionContext): Promise<HandlerOutcome>;
  undo?(payload: unknown, ctx: ExecutionContext): Promise<Message>;
}

export type AuthorizationDecision = { allowed: true } | { allowed: false; code: "unauthenticated" | "forbidden"; message: string };

/** Object-level authorization, evaluated on the trusted side for every preview and execution. */
export interface Authorizer {
  authorize(input: { plan: ActionPlan; definition: ActionDefinition; args: ActionArguments; ctx: ExecutionContext }): Promise<AuthorizationDecision> | AuthorizationDecision;
}

/**
 * Optional, pluggable intent proposer (e.g. a local or remote LLM). It only proposes; the
 * proposal goes through the same validation, clarification and confirmation as any parse.
 * The engine works fully without it.
 */
export interface IntentFallback {
  propose(input: string, manifest: RegistryManifest): Promise<{ actionId: string; arguments: Record<string, ArgumentValue> } | null>;
}

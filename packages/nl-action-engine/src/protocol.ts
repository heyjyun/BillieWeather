// The stable, serializable protocol shared by the parser (untrusted side) and the executor
// (trusted side). Everything here is plain JSON. `schema/*.json` describes the same shapes for
// hosts written in other languages; keep both in sync and bump PROTOCOL_VERSION on breaking changes.

import type { LanguageTag } from "./text";

export const PROTOCOL_VERSION = "nlae/1" as const;

/**
 * none   – reads, navigation, reversible UI preferences: runs without confirmation.
 * low    – creates something small and reversible.
 * medium – changes existing records.
 * high   – deletes or otherwise hard-to-reverse changes.
 */
export type RiskLevel = "none" | "low" | "medium" | "high";
/** none – run directly · confirm – explicit yes · typed – the person must type a phrase. */
export type ConfirmationLevel = "none" | "confirm" | "typed";

export type ParamType = "text" | "enum" | "entity" | "number" | "money" | "date" | "dateRange" | "boolean";

export interface EnumOption {
  value: string;
  /** Words or phrases for this value in any language; the value itself is always accepted. */
  aliases: string[];
}

export interface ParamSpec {
  name: string;
  type: ParamType;
  required?: boolean;
  description?: string;
  /** enum and boolean: allowed values. Boolean options use the values "true" / "false". */
  options?: EnumOption[];
  /** entity: which kind the host's EntityProvider lists (e.g. "document", "folder"). */
  entityKind?: string;
  /**
   * Words that introduce this parameter ("to", "as", "named", "改成", "叫"). For text parameters
   * the value is what follows the marker; for entities the search starts after it.
   */
  markers?: string[];
  /**
   * text: where the value comes from. "marker" = after a marker, "remainder" = whatever is left
   * after the command words and other parameters, "quoted" = only a quoted string.
   * Quoted strings are always preferred when present.
   */
  capture?: "marker" | "remainder" | "quoted";
  /** Parameters sharing a key can be filled from earlier turns ("…them", "same ones"). */
  contextKey?: string;
  /** Value used when the parameter is not given (never for entity parameters). */
  default?: ArgumentValue;
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface ActionDefinition {
  /** Unique, stable, namespaced ("notes.create"). */
  id: string;
  description: string;
  /** Command phrases and aliases in any language. Matching is typo- and script-tolerant. */
  expressions: string[];
  /** Example commands for suggestions and documentation. */
  examples?: string[];
  /** Words removed from free-text parameters of this action ("notes", "记录"). */
  fillers?: string[];
  params: ParamSpec[];
  risk: RiskLevel;
  /** May raise, never lower, the confirmation implied by `risk`. */
  confirmation?: ConfirmationLevel;
  /** For typed confirmation: the parameter whose display text must be typed. */
  typedConfirmationParam?: string;
  /** True when the handler can undo or compensate a completed execution. */
  undoable?: boolean;
  /**
   * Context references this action needs: "reference" = the command must point at something
   * ("delete it") and the engine has to resolve it from context; otherwise it asks.
   */
  context?: Array<{ param: string; requirement: "optional" | "reference" }>;
}

export type DateRangeValue = { start: string | null; end: string | null };
export type MoneyValue = { amountMinor: number; currency: string | null; comparator: "eq" | "gt" | "gte" | "lt" | "lte" };
export type ArgumentValue = string | number | boolean | DateRangeValue | MoneyValue;

export type ArgumentSource = "input" | "context" | "default" | "clarification" | "edit";

export interface PlanArgument {
  value: ArgumentValue;
  source: ArgumentSource;
  /** Exactly what the person typed for this value, when it came from the input. */
  raw?: string;
  /** Human-readable value (entity label, option value). */
  display?: string;
  /** Input was corrected (typo, homophone, script) to reach this value. */
  corrected?: boolean;
}

export interface TargetRef {
  param: string;
  kind: string;
  id: string;
  label: string;
  via: "input" | "context" | "clarification" | "edit";
}

export type NoteKind = "typo" | "homophone" | "script" | "assumption" | "context" | "followUp" | "default" | "ignored";

export interface PlanNote {
  kind: NoteKind;
  /** Stable code for hosts to translate, with English text as fallback. */
  code: string;
  message: string;
  vars?: Record<string, string | number>;
}

export interface ClarificationOption {
  value: string;
  label: string;
}

export interface Clarification {
  kind: "missing" | "choose" | "intent" | "reference" | "confirmIntent" | "invalid";
  /** Parameter being asked about; absent for intent questions. */
  param?: string;
  code: string;
  message: string;
  options: ClarificationOption[];
  /** The answer may be free text (text parameters). */
  freeText?: boolean;
  vars?: Record<string, string | number>;
}

export interface ProposedOperation {
  /** Host-defined verb ("update", "create", "delete", "navigate", "read"). */
  op: string;
  target: { kind: string; id: string; label: string };
  before?: unknown;
  after?: unknown;
}

export interface Message {
  code: string;
  message: string;
  vars?: Record<string, string | number>;
}

export type PlanStatus = "ready" | "needs_clarification" | "unsupported" | "invalid" | "cancelled";

export interface ActionPlan {
  protocol: typeof PROTOCOL_VERSION;
  /** Unique per plan; also the idempotency key when executing it. */
  planId: string;
  createdAt: string;
  input: string;
  language: LanguageTag;
  status: PlanStatus;
  intent: { actionId: string; score: number; matched: string } | null;
  alternatives: Array<{ actionId: string; score: number }>;
  arguments: Record<string, PlanArgument>;
  targets: TargetRef[];
  ambiguity: { ambiguous: boolean; reasons: string[] };
  clarification: Clarification | null;
  /** Filled by a preview on the trusted side. */
  operations: ProposedOperation[];
  /** Hash of `operations` from the last preview; execution refuses if the data changed since. */
  fingerprint: string | null;
  risk: RiskLevel;
  confirmation: ConfirmationLevel;
  /** For typed confirmation: what must be typed. */
  confirmationPhrase: string | null;
  notes: PlanNote[];
  /** Isolation scope: the plan is only valid for this product and tenant (account, workspace, database). */
  scope: { product: string; tenant: string };
  issues: Message[];
}

export interface ExecutionRequest {
  protocol: typeof PROTOCOL_VERSION;
  plan: ActionPlan;
  confirmation: { confirmed: boolean; typed?: string };
  /** Defaults to plan.planId. */
  idempotencyKey?: string;
}

export type ExecutionStatus = "succeeded" | "rejected" | "failed";

export type RejectionCode =
  | "protocol_mismatch" | "malformed_plan" | "not_ready" | "unknown_action" | "scope_mismatch" | "unauthenticated" | "forbidden"
  | "invalid_arguments" | "confirmation_required" | "typed_confirmation_mismatch" | "stale_preview" | "no_effect" | "in_progress"
  | "undo_unavailable" | "undo_expired";

export interface ExecutionResult {
  protocol: typeof PROTOCOL_VERSION;
  planId: string;
  status: ExecutionStatus;
  /** Rejection or failure code. */
  code?: RejectionCode | "handler_error";
  summary: Message;
  /** Host data for display (counts, totals). */
  data?: unknown;
  undo?: { token: string; expiresAt: string } | null;
  /** True when this is the stored result of an earlier identical request. */
  replayed: boolean;
  operations: ProposedOperation[];
}

export interface PreviewResult {
  plan: ActionPlan;
  ok: boolean;
  rejection?: { code: RejectionCode; summary: Message };
}

/** The serializable capability manifest a host publishes (e.g. to a non-JS backend). */
export interface RegistryManifest {
  protocol: typeof PROTOCOL_VERSION;
  product: string;
  version: string;
  actions: ActionDefinition[];
}

const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high"];
const CONFIRM_ORDER: ConfirmationLevel[] = ["none", "confirm", "typed"];

/** Data-modifying actions always need at least an explicit confirmation; high risk needs a typed one. */
export function confirmationFor(definition: Pick<ActionDefinition, "risk" | "confirmation">): ConfirmationLevel {
  const implied: ConfirmationLevel = definition.risk === "none" ? "none" : definition.risk === "high" ? "typed" : "confirm";
  const requested = definition.confirmation ?? "none";
  return CONFIRM_ORDER.indexOf(requested) > CONFIRM_ORDER.indexOf(implied) ? requested : implied;
}

export const riskAtLeast = (risk: RiskLevel, minimum: RiskLevel) => RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(minimum);

// Argument and plan validation shared by the parser and the trusted executor.

import type { EntityCandidate } from "./adapter";
import { PROTOCOL_VERSION, type ActionDefinition, type ActionPlan, type ArgumentValue, type Message, type ParamSpec } from "./protocol";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: unknown): boolean {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const issue = (code: string, message: string, vars: Record<string, string | number> = {}): Message => ({ code, message, vars });

/** Checks one value against its parameter spec. `entities` is the current list for entity params. */
export function checkValue(spec: ParamSpec, value: ArgumentValue, entities?: readonly EntityCandidate[]): Message | null {
  const vars = { param: spec.name };
  switch (spec.type) {
    case "text": {
      if (typeof value !== "string") return issue("type", `${spec.name} must be text`, vars);
      if (!value.trim()) return issue("blank", `${spec.name} cannot be blank`, vars);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return issue("control_chars", `${spec.name} contains control characters`, vars);
      const max = spec.maxLength ?? 500;
      if (Array.from(value).length > max) return issue("too_long", `${spec.name} is longer than ${max} characters`, { ...vars, max });
      return null;
    }
    case "enum":
    case "boolean": {
      const allowed = (spec.options ?? []).map((o) => o.value);
      const text = typeof value === "boolean" ? String(value) : value;
      if (typeof text !== "string" || !allowed.includes(text)) return issue("not_allowed", `${spec.name} must be one of ${allowed.join(", ")}`, vars);
      return null;
    }
    case "entity": {
      if (typeof value !== "string" || !value) return issue("type", `${spec.name} must be an id`, vars);
      if (entities && !entities.some((e) => e.id === value)) return issue("not_found", `${spec.name} does not exist`, vars);
      return null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return issue("type", `${spec.name} must be a number`, vars);
      if (spec.min !== undefined && value < spec.min) return issue("too_small", `${spec.name} must be at least ${spec.min}`, { ...vars, min: spec.min });
      if (spec.max !== undefined && value > spec.max) return issue("too_large", `${spec.name} must be at most ${spec.max}`, { ...vars, max: spec.max });
      return null;
    }
    case "money": {
      if (typeof value !== "object" || value === null || !("amountMinor" in value)) return issue("type", `${spec.name} must be an amount`, vars);
      if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0) return issue("type", `${spec.name} must be a non-negative amount`, vars);
      if (!["eq", "gt", "gte", "lt", "lte"].includes(value.comparator)) return issue("type", `${spec.name} has an unknown comparison`, vars);
      if (value.currency !== null && !/^[A-Z]{3}$/.test(value.currency)) return issue("type", `${spec.name} has an invalid currency`, vars);
      return null;
    }
    case "date":
      return isRealIsoDate(value) ? null : issue("type", `${spec.name} must be a date`, vars);
    case "dateRange": {
      if (typeof value !== "object" || value === null || !("start" in value)) return issue("type", `${spec.name} must be a date range`, vars);
      const { start, end } = value;
      if (start === null && end === null) return issue("type", `${spec.name} is empty`, vars);
      if ((start !== null && !isRealIsoDate(start)) || (end !== null && !isRealIsoDate(end))) return issue("type", `${spec.name} has an invalid date`, vars);
      if (start && end && start > end) return issue("reversed", `${spec.name} ends before it starts`, vars);
      return null;
    }
  }
}

/** Every problem with a complete argument set (unknown, missing, or invalid parameters). */
export function validateArguments(definition: ActionDefinition, args: Record<string, ArgumentValue>, entitiesByKind: Record<string, readonly EntityCandidate[]> = {}): Message[] {
  const issues: Message[] = [];
  const specs = new Map(definition.params.map((p) => [p.name, p]));
  for (const name of Object.keys(args)) if (!specs.has(name)) issues.push(issue("unknown_param", `unknown parameter ${name}`, { param: name }));
  for (const spec of definition.params) {
    const value = args[spec.name];
    if (value === undefined) {
      if (spec.required) issues.push(issue("missing", `${spec.name} is required`, { param: spec.name }));
      continue;
    }
    const problem = checkValue(spec, value, spec.entityKind ? entitiesByKind[spec.entityKind] : undefined);
    if (problem) issues.push(problem);
  }
  return issues;
}

/** Structural check of a plan received across a trust boundary. Returns a reason or null. */
export function planShapeProblem(plan: unknown): string | null {
  if (typeof plan !== "object" || plan === null) return "plan must be an object";
  const p = plan as Partial<ActionPlan>;
  if (typeof p.protocol !== "string") return "protocol field";
  if (p.protocol !== PROTOCOL_VERSION) return "protocol";
  if (typeof p.planId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(p.planId)) return "planId";
  if (typeof p.input !== "string" || p.input.length > 2000) return "input";
  if (!p.scope || typeof p.scope.product !== "string" || typeof p.scope.tenant !== "string") return "scope";
  if (!p.arguments || typeof p.arguments !== "object") return "arguments";
  for (const [name, argument] of Object.entries(p.arguments)) {
    if (!argument || typeof argument !== "object" || !("value" in argument)) return `argument ${name}`;
  }
  if (p.intent !== null && (typeof p.intent !== "object" || typeof p.intent?.actionId !== "string")) return "intent";
  return null;
}

/** NFKC, trimmed, case-insensitive comparison for typed confirmations. */
export function sameTypedPhrase(expected: string, typed: string | undefined): boolean {
  if (typed === undefined) return false;
  const fold = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return fold(expected) !== "" && fold(expected) === fold(typed);
}

/** Order-independent JSON, then FNV-1a (64-bit as two 32-bit halves). Detects changed previews; not a security hash. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === undefined) return "null";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  };
  const text = canonical(value);
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

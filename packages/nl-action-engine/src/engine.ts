// The parsing pipeline: normalize → tokenize → intent → parameters → context → plan → clarification.
// Deterministic, offline, no I/O except the host's EntityProvider. It never executes anything.

import type { ContextValue, EntityCandidate, EntityProvider, IntentFallback, ParseContext } from "./adapter";
import { defaultPhonetic, editDistance, matchPhrase, type PhoneticEncoder, type PhraseMatch } from "./fuzzy";
import {
  confirmationFor, PROTOCOL_VERSION, type ActionDefinition, type ActionPlan, type ArgumentValue, type Clarification, type ClarificationOption,
  type Message, type ParamSpec, type PlanArgument, type PlanNote, type TargetRef,
} from "./protocol";
import type { ActionRegistry } from "./registry";
import { detectLanguage, normalize, originalSlice, tokenize, toSimplifiedChar, type NormalizedText, type ScriptConverter, type Token } from "./text";
import { checkValue } from "./validate";
import { findDates, findMoney, findNumbers, findQuoted, localIsoDate, type Found } from "./values";

export interface EngineOptions {
  phonetic?: PhoneticEncoder;
  scriptConverter?: ScriptConverter;
  /** Minimum intent match quality (0..1). */
  intentThreshold?: number;
  /** Minimum entity/option match quality (0..1). */
  entityThreshold?: number;
  /** Two candidates closer than this are ambiguous. */
  ambiguityMargin?: number;
  idFactory?: () => string;
  fallback?: IntentFallback;
  /** Extra stopwords removed from free text (in addition to the built-in English/Chinese list). */
  stopwords?: string[];
}

/** One earlier turn the engine may refer back to. */
export interface HistoryTurn {
  plan: ActionPlan;
  at: number;
}

export interface InterpretOptions {
  /** Interpret as this action (after an intent clarification or an edit). */
  actionId?: string;
  /** Values already settled (clarification answers, edits). */
  answers?: Record<string, PlanArgument>;
  /** Parameters the person explicitly cleared. */
  cleared?: readonly string[];
  /** Earlier turns, newest last. */
  history?: readonly HistoryTurn[];
  /** The person confirmed an intent the engine was unsure about. */
  intentConfirmed?: boolean;
}

export interface Suggestion {
  text: string;
  actionId: string;
}

const PRONOUNS = ["it", "them", "that", "those", "this", "these", "the same", "same ones", "that one", "this one", "those ones", "它", "它们", "这个", "那个", "这些", "那些", "这笔", "那笔", "这几笔", "那几笔", "刚才的", "刚刚的", "上面的", "同样的"];
const NEGATIONS_EN = new Set(["don't", "dont", "do not", "never", "not", "doesn't", "shouldn't", "won't"]);
const NEGATIONS_ZH = ["不要", "不用", "不必", "无需", "请勿", "千万别", "别再", "勿"];
const STOPWORDS = [
  "the", "a", "an", "my", "all", "any", "of", "for", "from", "with", "on", "at", "in", "into", "to", "please", "pls", "can", "you", "could", "would", "i", "me", "want", "need",
  "and", "also", "just", "some", "every", "each", "is", "are", "was", "were", "be", "which", "now", "then", "again", "only",
  "的", "了", "把", "将", "我", "请", "帮", "帮我", "给我", "一下", "所有", "全部", "都", "吧", "呢", "吗", "啊", "里", "中", "在", "从", "和", "跟", "让", "被", "这", "那", "下",
];

const fallbackId = () => {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `plan_${random}`;
};

interface Candidate {
  definition: ActionDefinition;
  match: PhraseMatch;
  expression: string;
  rank: number;
}

interface Shared {
  source: NormalizedText;
  tokens: Token[];
  dates: Array<Found<import("./protocol").DateRangeValue>>;
  money: Array<Found<import("./protocol").MoneyValue>>;
  numbers: Array<Found<number>>;
  quoted: Array<Found<string>>;
}

interface Extraction {
  args: Record<string, PlanArgument>;
  targets: TargetRef[];
  notes: PlanNote[];
  issues: Message[];
  clarification: Clarification | null;
  fit: number;
  ambiguity: string[];
}

const note = (kind: PlanNote["kind"], code: string, message: string, vars?: PlanNote["vars"]): PlanNote => ({ kind, code, message, ...(vars ? { vars } : {}) });

export class NaturalLanguageEngine {
  private readonly phonetic: PhoneticEncoder;
  private readonly convert: ScriptConverter;
  private readonly intentThreshold: number;
  private readonly entityThreshold: number;
  private readonly margin: number;
  private readonly newId: () => string;
  private readonly stopwords: Token[][];
  private readonly pronouns: Token[][];
  private readonly expressionTokens = new Map<string, Token[]>();

  constructor(readonly registry: ActionRegistry, private readonly entities: EntityProvider, private readonly options: EngineOptions = {}) {
    this.phonetic = options.phonetic ?? defaultPhonetic;
    this.convert = options.scriptConverter ?? toSimplifiedChar;
    this.intentThreshold = options.intentThreshold ?? 0.7;
    this.entityThreshold = options.entityThreshold ?? 0.7;
    this.margin = options.ambiguityMargin ?? 0.05;
    this.newId = options.idFactory ?? fallbackId;
    this.stopwords = [...STOPWORDS, ...(options.stopwords ?? [])].map((w) => this.tokens(w)).sort((a, b) => b.length - a.length);
    this.pronouns = PRONOUNS.map((w) => this.tokens(w)).sort((a, b) => b.length - a.length);
  }

  /** Tokens of a vocabulary phrase, normalized like the input (cached). */
  private tokens(phrase: string): Token[] {
    let cached = this.expressionTokens.get(phrase);
    if (!cached) {
      cached = tokenize(normalize(phrase, this.convert).text).filter((t) => t.kind !== "symbol");
      this.expressionTokens.set(phrase, cached);
    }
    return cached;
  }

  async interpret(input: string, ctx: ParseContext, opts: InterpretOptions = {}): Promise<ActionPlan> {
    const source = normalize(input.slice(0, 2000), this.convert);
    const tokens = tokenize(source.text);
    const today = ctx.today ?? localIsoDate(ctx.now ?? new Date());
    const language = detectLanguage(input).language;
    const base = this.emptyPlan(input, language, ctx);
    if (!tokens.some((t) => t.kind !== "symbol")) return { ...base, status: "unsupported", issues: [{ code: "empty", message: "Type a command." }] };

    const shared: Shared = {
      source, tokens,
      dates: findDates(source, tokens, today, this.phonetic),
      money: findMoney(source, ctx.defaultCurrency ?? null),
      numbers: findNumbers(source),
      quoted: findQuoted(source),
    };
    // Quoted text, dates and amounts are values, never command words ("去年" is not "去").
    const valueSpans = [...shared.quoted, ...shared.dates, ...shared.money];
    const insideValue = (t: Token) => valueSpans.some((v) => t.start >= v.start && t.end <= v.end);
    const intentAvailable = (i: number) => tokens[i].kind !== "symbol" && !insideValue(tokens[i]);

    // ---- intent ----
    let candidates: Candidate[] = [];
    const negated: string[] = [];
    if (opts.actionId) {
      const definition = this.registry.get(opts.actionId);
      if (!definition) return { ...base, status: "unsupported", issues: [{ code: "unknown_action", message: "That action is not available." }] };
      const found = this.bestExpression(definition, tokens, intentAvailable);
      candidates = [{ definition, match: found?.match ?? { quality: 1, matched: [], first: 0, last: 0, corrections: [] }, expression: found?.expression ?? "", rank: 1 }];
    } else {
      for (const definition of this.registry.all()) {
        const found = this.bestExpression(definition, tokens, intentAvailable);
        if (!found || found.match.quality < this.intentThreshold) continue;
        if (this.isNegated(tokens, found.match)) {
          negated.push(definition.id);
          continue;
        }
        candidates.push({ definition, ...found, rank: found.match.quality + 0.04 * Math.min(this.tokens(found.expression).length, 5) });
      }
      // A reading whose command words are contained in a longer reading's loses ("计入" inside "不计入").
      candidates = candidates.filter((c) => !candidates.some((other) => other !== c && other.match.matched.length > c.match.matched.length && c.match.matched.every((i) => other.match.matched.includes(i))));
      candidates.sort((a, b) => b.rank - a.rank);
    }

    if (!candidates.length) {
      if (negated.length) return { ...base, status: "unsupported", issues: [{ code: "negated", message: "That sounds like something not to do, so nothing was planned." }], notes: [note("assumption", "negated", "A negation was found; nothing will run.")] };
      const followUp = await this.followUp(shared, ctx, opts, base);
      if (followUp) return followUp;
      const proposed = await this.fromFallback(input, ctx, opts, base);
      if (proposed) return proposed;
      return { ...base, status: "unsupported", alternatives: this.nearMisses(tokens, intentAvailable), issues: [{ code: "unsupported", message: "That command isn't supported." }] };
    }

    // ---- parameters for the strongest few candidates; parameter fit breaks near-ties ----
    const scored: Array<{ candidate: Candidate; extraction: Extraction; score: number }> = [];
    for (const candidate of candidates.slice(0, 4)) {
      const extraction = await this.extract(candidate.definition, candidate.match, shared, ctx, opts);
      scored.push({ candidate, extraction, score: candidate.rank + 0.15 * extraction.fit - (extraction.clarification ? 0.05 : 0) });
    }
    scored.sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    const definition = best.candidate.definition;
    const plan: ActionPlan = {
      ...base,
      intent: { actionId: definition.id, score: round(best.candidate.match.quality), matched: best.candidate.expression },
      alternatives: scored.slice(1).map((s) => ({ actionId: s.candidate.definition.id, score: round(s.candidate.match.quality) })),
      arguments: best.extraction.args,
      targets: best.extraction.targets,
      notes: [...this.intentNotes(best.candidate, language), ...best.extraction.notes],
      issues: best.extraction.issues,
      risk: definition.risk,
      confirmation: confirmationFor(definition),
    };
    plan.confirmationPhrase = this.typedPhrase(definition, plan.arguments);

    let clarification = best.extraction.clarification;
    const reasons = [...best.extraction.ambiguity];
    if (!opts.actionId && second && second.candidate.definition.id !== definition.id && best.score - second.score < this.margin) {
      reasons.push("intent");
      clarification = {
        kind: "intent", code: "which_action", message: "Which did you mean?",
        options: [best, second].map((s) => ({ value: s.candidate.definition.id, label: s.candidate.definition.description })),
      };
    }
    // A data-changing command that leaves most of the input unexplained, or whose free-text value is a
    // whole sentence, may not be a command at all: ask first.
    const longFreeText = definition.params.some((p) => p.type === "text" && (p.capture ?? "remainder") === "remainder" && plan.arguments[p.name]?.source === "input" && wordCount(String(plan.arguments[p.name].value)) > 4);
    if (!clarification && !opts.intentConfirmed && definition.risk !== "none" && (best.extraction.fit < 0.5 || longFreeText) && !opts.actionId) {
      reasons.push(longFreeText ? "long_free_text" : "low_coverage");
      clarification = { kind: "confirmIntent", code: "confirm_intent", message: `Do you want to: ${definition.description}?`, vars: { action: definition.id }, options: yesNo() };
    }
    plan.clarification = clarification;
    plan.ambiguity = { ambiguous: reasons.length > 0, reasons };
    plan.status = clarification ? "needs_clarification" : plan.issues.length ? "invalid" : "ready";
    return plan;
  }

  /**
   * Applies edits from the structured preview and re-validates the plan.
   * `null` clears an optional parameter.
   */
  async revise(plan: ActionPlan, edits: Record<string, ArgumentValue | null>, ctx: ParseContext, history: readonly HistoryTurn[] = []): Promise<ActionPlan> {
    if (!plan.intent) return plan;
    const answers: Record<string, PlanArgument> = {};
    for (const [name, argument] of Object.entries(plan.arguments)) if (argument.source !== "default") answers[name] = argument;
    const cleared: string[] = [];
    for (const [name, value] of Object.entries(edits)) {
      if (value === null) {
        delete answers[name];
        cleared.push(name);
      } else {
        answers[name] = { value, source: "edit" };
      }
    }
    return this.interpret(plan.input, ctx, { actionId: plan.intent.actionId, answers, cleared, history, intentConfirmed: true });
  }

  /** Completions for the command bar: matching example commands, most relevant first. */
  suggest(prefix: string, options: { limit?: number; preferHan?: boolean } = {}): Suggestion[] {
    const limit = options.limit ?? 6;
    const all = this.registry.all().flatMap((d) => (d.examples ?? d.expressions).map((text) => ({ text, actionId: d.id })));
    const trimmed = prefix.trim();
    const han = (s: string) => /[㐀-鿿]/u.test(s);
    if (!trimmed) {
      const preferHan = options.preferHan ?? false;
      const seen = new Set<string>();
      return all.filter((s) => han(s.text) === preferHan && !seen.has(s.actionId) && seen.add(s.actionId)).slice(0, limit);
    }
    const pattern = this.tokens(trimmed);
    if (!pattern.length) return [];
    const preferHan = han(trimmed);
    const scored: Array<Suggestion & { score: number }> = [];
    for (const suggestion of all) {
      if (han(suggestion.text) !== preferHan && !/[a-z]/i.test(trimmed)) continue;
      const text = this.tokens(suggestion.text);
      const match = matchPhrase(pattern, text, { phonetic: this.phonetic, prefixLast: true });
      if (!match || match.matched.length !== pattern.length || match.quality < 0.6) continue;
      scored.push({ ...suggestion, score: match.quality - match.first * 0.02 - text.length * 0.001 });
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    return scored.filter((s) => !seen.has(s.text) && seen.add(s.text)).slice(0, limit).map(({ text, actionId }) => ({ text, actionId }));
  }

  // ---------- intent helpers ----------

  private bestExpression(definition: ActionDefinition, tokens: Token[], available: (i: number) => boolean): { match: PhraseMatch; expression: string } | null {
    let best: { match: PhraseMatch; expression: string } | null = null;
    for (const expression of definition.expressions) {
      const pattern = this.tokens(expression);
      if (!pattern.length) continue;
      const match = matchPhrase(pattern, tokens, { phonetic: this.phonetic }, available);
      if (!match || match.matched.length !== pattern.length) continue;
      // Narration is not a command: "moved", "deleted", "renamed" never count as "move", "delete", "rename".
      if (match.corrections.some((c) => c.kind === "typo" && (c.from === `${c.to}d` || c.from === `${c.to}ed` || (c.to.endsWith("e") && c.from === `${c.to.slice(0, -1)}ing`) || c.from === `${c.to}ing`))) continue;
      // One-character Chinese expressions must match exactly (no homophones).
      if (pattern.length === 1 && pattern[0].kind === "han" && match.corrections.length) continue;
      const specificity = (m: PhraseMatch, p: Token[]) => m.quality + 0.04 * Math.min(p.length, 5);
      if (!best || specificity(match, pattern) > specificity(best.match, this.tokens(best.expression))) best = { match, expression };
    }
    return best;
  }

  /** A negation earlier in the same clause ("don't …", "never …", "别把…", "不要…") cancels the command. */
  private isNegated(tokens: Token[], match: PhraseMatch): boolean {
    let start = match.first;
    while (start > 0 && !(tokens[start - 1].kind === "symbol" && /[,.;!?]/.test(tokens[start - 1].text))) start -= 1;
    const before = tokens.slice(start, match.first).filter((_, k) => !match.matched.includes(start + k));
    const words = before.filter((t) => t.kind === "word").map((t) => t.text);
    for (let i = 0; i < words.length; i++) {
      if (NEGATIONS_EN.has(words[i]) || NEGATIONS_EN.has(`${words[i]} ${words[i + 1] ?? ""}`.trim())) return true;
    }
    const han = before.filter((t) => t.kind === "han").map((t) => t.text).join("");
    if (NEGATIONS_ZH.some((n) => han.includes(n))) return true;
    // 别 is a negation only when it is not part of a word such as 类别 / 区别 / 级别.
    for (let i = 0; i < before.length; i++) {
      if (before[i].text !== "别") continue;
      const previous = before[i - 1] ?? tokens[start - 1];
      if (!(previous && "类区级性特分告识个辨鉴差".includes(previous.text))) return true;
    }
    return false;
  }

  private intentNotes(candidate: Candidate, language: string): PlanNote[] {
    const notes: PlanNote[] = [];
    for (const correction of candidate.match.corrections) {
      const kind = correction.kind === "homophone" ? "homophone" : "typo";
      notes.push(note(kind, `intent_${kind}`, `Read "${correction.from}" as "${correction.to}".`, { from: correction.from, to: correction.to }));
    }
    if (language === "zh-Hant") notes.push(note("script", "traditional_input", "Traditional Chinese was matched using its Simplified forms; your text is kept as typed."));
    return notes;
  }

  private nearMisses(tokens: Token[], available: (i: number) => boolean) {
    const out: Array<{ actionId: string; score: number }> = [];
    for (const definition of this.registry.all()) {
      const found = this.bestExpression(definition, tokens, available);
      if (found && found.match.quality >= 0.4) out.push({ actionId: definition.id, score: round(found.match.quality) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  // ---------- parameters ----------

  private async extract(definition: ActionDefinition, intent: PhraseMatch, shared: Shared, ctx: ParseContext, opts: InterpretOptions): Promise<Extraction> {
    const { source, tokens } = shared;
    const used = new Array<boolean>(tokens.length).fill(false);
    for (const i of intent.matched) used[i] = true;
    const markSpan = (start: number, end: number) => tokens.forEach((t, i) => { if (t.start >= start && t.end <= end) used[i] = true; });
    const free = (i: number) => !used[i] && tokens[i].kind !== "symbol";
    // Options may reuse command words ("dark mode" can be both the command and the value).
    const intentTokens = new Set(intent.matched);
    const usedByValue = new Array<boolean>(tokens.length).fill(false);
    const optionFree = (i: number) => tokens[i].kind !== "symbol" && (!used[i] || (intentTokens.has(i) && !usedByValue[i]));
    const spanFree = (start: number, end: number) => tokens.every((t, i) => !(t.start >= start && t.end <= end) || !used[i]);

    const args: Record<string, PlanArgument> = {};
    const targets: TargetRef[] = [];
    const notes: PlanNote[] = [];
    const issues: Message[] = [];
    const ambiguity: string[] = [];
    let clarification: Clarification | null = null;
    const ask = (c: Clarification) => { if (!clarification) clarification = c; };
    const cleared = new Set(opts.cleared ?? []);
    const answers = opts.answers ?? {};
    const entityLists = new Map<string, readonly EntityCandidate[]>();
    const listFor = async (kind: string) => {
      if (!entityLists.has(kind)) entityLists.set(kind, await this.entities.list(kind, { product: ctx.product, tenant: ctx.tenant }));
      return entityLists.get(kind)!;
    };

    // Settled answers first.
    for (const spec of definition.params) {
      const answer = answers[spec.name];
      if (!answer) continue;
      if (spec.type === "entity") {
        const entity = (await listFor(spec.entityKind!)).find((e) => e.id === answer.value);
        if (!entity) {
          ask({ ...this.chooseEntity(spec, await listFor(spec.entityKind!), "not_found", `I couldn't find that ${spec.entityKind}. Choose one:`), vars: { param: spec.name } });
          continue;
        }
        args[spec.name] = { ...answer, display: entity.label };
        targets.push({ param: spec.name, kind: spec.entityKind!, id: entity.id, label: entity.label, via: answer.source === "context" ? "context" : answer.source === "edit" ? "edit" : answer.source === "clarification" ? "clarification" : "input" });
      } else {
        args[spec.name] = answer;
      }
    }
    const open = (spec: ParamSpec) => !(spec.name in args) && !cleared.has(spec.name);

    // Marker positions for every parameter (so values stop at the next parameter's marker).
    const markerHits: Array<{ param: string; first: number; last: number }> = [];
    for (const spec of definition.params) {
      for (const marker of spec.markers ?? []) {
        const pattern = this.tokens(marker);
        for (let i = 0; i + pattern.length <= tokens.length; i++) {
          if (pattern.every((p, k) => tokens[i + k].text === p.text && !used[i + k])) markerHits.push({ param: spec.name, first: i, last: i + pattern.length - 1 });
        }
      }
    }
    markerHits.sort((a, b) => a.first - b.first);
    const markerFor = (spec: ParamSpec) => markerHits.filter((h) => h.param === spec.name && h.first > intent.last - (intent.matched.length ? 0 : Infinity)).at(0) ?? markerHits.find((h) => h.param === spec.name);
    const segmentAfter = (hit: { param: string; last: number }) => {
      const next = markerHits.find((h) => h.first > hit.last && h.param !== hit.param);
      return { from: hit.last + 1, to: next ? next.first - 1 : tokens.length - 1 };
    };

    // 1. Quoted strings go to the parameter whose marker precedes them, else the first open text/entity parameter.
    for (const quote of shared.quoted) {
      const firstToken = tokens.findIndex((t) => t.start >= quote.start);
      const markerBefore = markerHits.filter((h) => h.last < firstToken && firstToken - h.last <= 2).at(-1);
      const spec = (markerBefore && definition.params.find((p) => p.name === markerBefore.param && open(p) && (p.type === "text" || p.type === "entity")))
        ?? definition.params.find((p) => open(p) && (p.type === "text" || p.type === "entity"));
      if (!spec) continue;
      markSpan(quote.start, quote.end);
      if (markerBefore) for (let i = markerBefore.first; i <= markerBefore.last; i++) used[i] = true;
      if (spec.type === "text") {
        args[spec.name] = { value: quote.value, source: "input", raw: quote.value };
      } else {
        const resolved = await this.resolveEntity(spec, await listFor(spec.entityKind!), this.tokens(quote.value), () => true, true);
        this.applyEntity(spec, resolved, args, targets, notes, ambiguity, ask, quote.value);
      }
    }

    // A marker right before a structured value belongs to it ("due 2026-12-01", "截止 明天").
    const claimMarker = (spec: ParamSpec, start: number) => {
      const first = tokens.findIndex((t) => t.start >= start);
      for (const hit of markerHits) if (hit.param === spec.name && hit.last === first - 1) for (let i = hit.first; i <= hit.last; i++) used[i] = true;
    };

    // 2. Dates, money, numbers.
    for (const spec of definition.params.filter(open)) {
      if (spec.type === "dateRange" || spec.type === "date") {
        const hit = shared.dates.find((d) => spanFree(d.start, d.end) && (spec.type === "dateRange" || (d.value.start && d.value.start === d.value.end)));
        if (!hit) continue;
        markSpan(hit.start, hit.end);
        claimMarker(spec, hit.start);
        const value = spec.type === "date" ? hit.value.start! : hit.value;
        args[spec.name] = { value, source: "input", raw: originalSlice(source, hit.start, hit.end), corrected: hit.corrected, display: formatRange(hit.value) };
        if (hit.corrected) notes.push(note("typo", "date_typo", `Read "${originalSlice(source, hit.start, hit.end)}" as ${formatRange(hit.value)}.`, { from: originalSlice(source, hit.start, hit.end), to: formatRange(hit.value) }));
        if (hit.assumption) notes.push(note("assumption", "date_past_year", `Assumed the most recent ${originalSlice(source, hit.start, hit.end)}: ${formatRange(hit.value)}.`, { from: originalSlice(source, hit.start, hit.end), to: formatRange(hit.value) }));
      } else if (spec.type === "money") {
        const hit = shared.money.find((m) => spanFree(m.start, m.end));
        if (!hit) continue;
        markSpan(hit.start, hit.end);
        claimMarker(spec, hit.start);
        args[spec.name] = { value: hit.value, source: "input", raw: originalSlice(source, hit.start, hit.end) };
        if (!hit.value.currency) notes.push(note("assumption", "money_no_currency", "No currency given; the default currency applies."));
      }
    }
    for (const spec of definition.params.filter((p) => open(p) && p.type === "number")) {
      const hit = shared.numbers.find((n) => spanFree(n.start, n.end));
      if (!hit) continue;
      markSpan(hit.start, hit.end);
      args[spec.name] = { value: hit.value, source: "input", raw: originalSlice(source, hit.start, hit.end) };
    }

    // 3. Enum and boolean options.
    for (const spec of definition.params.filter((p) => open(p) && (p.type === "enum" || p.type === "boolean"))) {
      const scored: Array<{ value: string; match: PhraseMatch }> = [];
      for (const option of spec.options ?? []) {
        for (const alias of [option.value, ...option.aliases]) {
          const pattern = this.tokens(alias);
          if (!pattern.length) continue;
          const match = matchPhrase(pattern, tokens, { phonetic: this.phonetic }, optionFree);
          if (!match || match.matched.length !== pattern.length || match.last - match.first + 1 !== pattern.length || match.quality < this.entityThreshold) continue;
          if (pattern.length === 1 && pattern[0].kind === "han" && match.corrections.length) continue;
          scored.push({ value: option.value, match });
        }
      }
      scored.sort((a, b) => b.match.quality - a.match.quality || b.match.matched.length - a.match.matched.length);
      const top = scored[0];
      if (!top) continue;
      const rival = scored.find((s) => s.value !== top.value && top.match.quality - s.match.quality < this.margin && s.match.matched.length >= top.match.matched.length);
      if (rival) {
        ambiguity.push(spec.name);
        ask({ kind: "choose", param: spec.name, code: "choose_option", message: `Which ${spec.name}?`, vars: { param: spec.name }, options: [...new Set([top.value, rival.value])].map((v) => ({ value: v, label: v })) });
        continue;
      }
      for (const i of top.match.matched) { used[i] = true; usedByValue[i] = true; }
      args[spec.name] = { value: spec.type === "boolean" ? top.value === "true" : top.value, source: "input", raw: top.match.matched.map((i) => tokens[i].text).join(" "), display: top.value, corrected: top.match.corrections.length > 0 };
      if (top.match.corrections.length) notes.push(note("typo", "option_typo", `Read "${top.match.corrections.map((c) => c.from).join(" ")}" as "${top.value}".`, { from: top.match.corrections.map((c) => c.from).join(" "), to: top.value, param: spec.name }));
    }

    // 4. Entities (searching after their marker when there is one).
    for (const spec of definition.params.filter((p) => open(p) && p.type === "entity")) {
      const hit = markerFor(spec);
      const segment = hit ? segmentAfter(hit) : { from: 0, to: tokens.length - 1 };
      const within = (i: number) => free(i) && i >= segment.from && i <= segment.to;
      let resolved = await this.resolveEntity(spec, await listFor(spec.entityKind!), tokens, within, false);
      // Without a marker, a spelling-corrected word may just be part of a free-text value
      // ("whole foods" is a shop, not "food"): only exact or same-sounding matches count there.
      const hasRemainder = definition.params.some((p) => p.type === "text" && (p.capture ?? "remainder") === "remainder");
      if (!hit && hasRemainder && resolved.kind === "one" && resolved.match.corrections.some((c) => c.kind === "typo")) resolved = { kind: "none" };
      if (resolved.kind === "none") continue;
      if (hit) for (let i = hit.first; i <= hit.last; i++) used[i] = true;
      if (resolved.kind === "one") for (const i of resolved.match.matched) used[i] = true;
      if (resolved.kind === "many") for (const i of resolved.matched) used[i] = true;
      this.applyEntity(spec, resolved, args, targets, notes, ambiguity, ask, resolved.kind === "one" ? originalSlice(source, tokens[resolved.match.first].start, tokens[resolved.match.last].end) : undefined);
    }

    // 5. Text after a marker.
    for (const spec of definition.params.filter((p) => open(p) && p.type === "text" && (p.capture ?? "remainder") === "marker")) {
      const hit = markerFor(spec);
      if (!hit) continue;
      const segment = segmentAfter(hit);
      const indices = this.trimStop(tokens, range(segment.from, segment.to).filter(free));
      for (let i = hit.first; i <= hit.last; i++) used[i] = true;
      if (!indices.length) continue;
      const run = longestRun(indices);
      for (const i of run) used[i] = true;
      const raw = originalSlice(source, tokens[run[0]].start, tokens[run[run.length - 1]].end);
      args[spec.name] = { value: stripEdgePunctuation(raw), source: "input", raw };
    }

    // 6. References ("them", "这些").
    let referenced = false;
    const markerStarts = new Set(markerHits.map((h) => h.first));
    for (const pronoun of this.pronouns) {
      for (let i = 0; i + pronoun.length <= tokens.length; i++) {
        if (pronoun.every((p, k) => tokens[i + k].text === p.text && free(i + k))) {
          // "that"/"this" are pronouns only when nothing descriptive follows ("move that to…", "delete this").
          if (pronoun.length === 1 && (pronoun[0].text === "that" || pronoun[0].text === "this")) {
            const next = tokens[i + 1];
            if (next && next.kind !== "symbol" && !markerStarts.has(i + 1) && !["one", "ones", "too", "as", "to", "into"].includes(next.text)) continue;
          }
          referenced = true;
          for (let k = 0; k < pronoun.length; k++) used[i + k] = true;
        }
      }
    }

    // 7. Free-text remainder.
    const fillers = (definition.fillers ?? []).map((f) => this.tokens(f));
    for (const spec of definition.params.filter((p) => open(p) && p.type === "text" && (p.capture ?? "remainder") === "remainder")) {
      for (const hit of markerHits) if (hit.param === spec.name) for (let i = hit.first; i <= hit.last; i++) used[i] = true;
      const remaining = range(0, tokens.length - 1).filter(free);
      this.removePhrases(tokens, remaining, fillers, used);
      const indices = this.trimStop(tokens, range(0, tokens.length - 1).filter(free));
      if (!indices.length) continue;
      const run = longestRun(indices);
      const raw = originalSlice(source, tokens[run[0]].start, tokens[run[run.length - 1]].end);
      for (const i of run) used[i] = true;
      args[spec.name] = { value: stripEdgePunctuation(raw), source: "input", raw };
      const dropped = indices.filter((i) => !run.includes(i)).map((i) => tokens[i].text);
      if (dropped.length) notes.push(note("ignored", "words_ignored", `Ignored: ${dropped.join(" ")}`, { words: dropped.join(" ") }));
    }

    // 8. Context: fill from earlier turns or the host's focus when the input points back.
    const requirements = new Map((definition.context ?? []).map((c) => [c.param, c.requirement]));
    let resolvedReference = false;
    let unresolved: ParamSpec | null = null;
    for (const spec of definition.params.filter(open)) {
      if (!spec.contextKey) continue;
      const requirement = requirements.get(spec.name) ?? "optional";
      // Without a pronoun, a missing required value is taken from context only for non-destructive
      // actions, and is reported as an assumption (data-changing plans are confirmed anyway).
      const assumed = !referenced && requirement !== "reference" && spec.required === true && definition.risk !== "high";
      if (!referenced && requirement !== "reference" && !assumed) continue;
      const found = this.fromContext(spec, ctx, opts.history ?? []);
      if (!found) {
        // Optional values the earlier turn simply didn't have are fine; only an unresolved required one is a question.
        if (referenced && (spec.required || requirement === "reference") && !unresolved) unresolved = spec;
        continue;
      }
      resolvedReference = true;
      if (spec.type === "entity") {
        const entity = (await listFor(spec.entityKind!)).find((e) => e.id === found.value);
        if (!entity) continue; // it no longer exists
        args[spec.name] = { value: entity.id, source: "context", display: entity.label };
        targets.push({ param: spec.name, kind: spec.entityKind!, id: entity.id, label: entity.label, via: "context" });
      } else {
        args[spec.name] = { value: found.value, source: "context", display: found.display };
      }
      notes.push(note(assumed ? "assumption" : "context", assumed ? "assumed_from_context" : "from_context", `Used "${found.display ?? String(found.value)}" from earlier for ${spec.name}.`, { param: spec.name, value: found.display ?? String(found.value) }));
    }
    if (unresolved || (referenced && !resolvedReference && definition.params.some((p) => p.contextKey && open(p) && p.required))) {
      const spec = unresolved ?? definition.params.find((p) => p.contextKey && open(p) && p.required)!;
      ambiguity.push("reference");
      ask({ kind: "reference", param: spec.name, code: "unresolved_reference", message: `What does that refer to? Please name the ${spec.entityKind ?? spec.name}.`, vars: { param: spec.name }, options: [], freeText: spec.type === "text" });
    }

    // 9. Defaults, then validation.
    for (const spec of definition.params) {
      if (spec.name in args || cleared.has(spec.name) || spec.default === undefined) continue;
      args[spec.name] = { value: spec.default, source: "default", display: typeof spec.default === "object" ? formatRange(spec.default as never) : String(spec.default) };
    }
    for (const spec of definition.params) {
      const argument = args[spec.name];
      if (!argument) {
        if (spec.required) ask(await this.missing(spec, listFor));
        continue;
      }
      const problem = checkValue(spec, argument.value, spec.entityKind ? await listFor(spec.entityKind) : undefined);
      if (problem) {
        issues.push(problem);
        ask({ kind: "invalid", param: spec.name, code: `invalid_${problem.code}`, message: problem.message, vars: { param: spec.name, ...(problem.vars ?? {}) }, options: [], freeText: spec.type === "text" });
      }
    }

    // Fit: how much of the input this reading explains, and whether required parameters are present.
    const content = tokens.map((_, i) => i).filter((i) => tokens[i].kind !== "symbol" && !this.isStop(tokens, i));
    const explained = content.filter((i) => used[i]).length;
    const required = definition.params.filter((p) => p.required);
    const filled = required.filter((p) => p.name in args).length;
    const coverage = content.length ? explained / content.length : 1;
    const fit = (required.length ? 0.5 * (filled / required.length) : 0.5) + 0.5 * coverage;
    if (!definition.params.some((p) => p.type === "text" && (p.capture ?? "remainder") === "remainder")) {
      const leftovers = content.filter((i) => !used[i]).map((i) => tokens[i].text);
      if (leftovers.length) notes.push(note("ignored", "words_ignored", `Ignored: ${leftovers.join(" ")}`, { words: leftovers.join(" ") }));
    }
    return { args, targets, notes, issues, clarification, fit: coverage < 0.5 && definition.risk !== "none" ? Math.min(fit, coverage) : fit, ambiguity };
  }

  private async resolveEntity(spec: ParamSpec, list: readonly EntityCandidate[], tokens: readonly Token[], available: (i: number) => boolean, whole: boolean):
    Promise<{ kind: "none" } | { kind: "one"; entity: EntityCandidate; match: PhraseMatch; alias: string; partial?: boolean } | { kind: "many"; entities: EntityCandidate[]; matched: number[] }> {
    const scored: Array<{ entity: EntityCandidate; match: PhraseMatch; alias: string; exact: boolean }> = [];
    for (const entity of list) {
      let best: { match: PhraseMatch; alias: string; exact: boolean } | null = null;
      for (const alias of [entity.label, ...(entity.aliases ?? [])]) {
        const pattern = this.tokens(alias);
        if (!pattern.length) continue;
        const match = matchPhrase(pattern, tokens, { phonetic: this.phonetic }, available);
        if (!match || match.matched.length !== pattern.length || match.last - match.first + 1 !== pattern.length) continue;
        if (match.quality < this.entityThreshold) continue;
        if (pattern.length === 1 && pattern[0].kind === "han" && match.corrections.length) continue;
        // A whole quoted value must be the alias, not merely contain it.
        if (whole && tokens.length !== pattern.length && match.quality < 1) continue;
        const exact = match.quality === 1;
        if (!best || match.quality > best.match.quality || (match.quality === best.match.quality && pattern.length > this.tokens(best.alias).length)) best = { match, alias, exact };
      }
      if (best) scored.push({ entity, ...best });
    }
    if (!scored.length && !whole) {
      // Partial names: one distinctive word of a multi-word name ("budget" → "Budget 2026"), or two
      // adjacent characters of a longer Chinese name. Never chosen silently when several fit.
      const partial: Array<{ entity: EntityCandidate; matched: number[] }> = [];
      for (const entity of list) {
        const pieces = new Set<string>();
        for (const alias of [entity.label, ...(entity.aliases ?? [])]) {
          const aliasTokens = this.tokens(alias);
          if (aliasTokens.length < 2) continue;
          for (const t of aliasTokens) if (t.kind === "word" && t.text.length >= 4) pieces.add(t.text);
          for (let i = 0; i + 1 < aliasTokens.length; i++) if (aliasTokens[i].kind === "han" && aliasTokens[i + 1].kind === "han") pieces.add(aliasTokens[i].text + aliasTokens[i + 1].text);
        }
        for (const piece of pieces) {
          const pattern = this.tokens(piece);
          const match = matchPhrase(pattern, tokens, { phonetic: this.phonetic }, available);
          if (match && match.quality === 1 && match.matched.length === pattern.length && match.last - match.first + 1 === pattern.length) { partial.push({ entity, matched: match.matched }); break; }
        }
      }
      if (partial.length === 1) return { kind: "one", entity: partial[0].entity, match: { quality: 0.75, matched: partial[0].matched, first: partial[0].matched[0], last: partial[0].matched.at(-1)!, corrections: [] }, alias: partial[0].entity.label, partial: true };
      if (partial.length > 1) return { kind: "many", entities: partial.map((p) => p.entity), matched: partial[0].matched };
    }
    if (!scored.length) return { kind: "none" };
    const length = (s: { alias: string }) => this.tokens(s.alias).length;
    scored.sort((a, b) => b.match.quality - a.match.quality || length(b) - length(a));
    const top = scored[0];
    const rivals = scored.filter((s) => s.entity.id !== top.entity.id && top.match.quality - s.match.quality < this.margin && length(s) >= length(top));
    if (rivals.length) {
      const entities = [top, ...rivals].map((s) => s.entity);
      return { kind: "many", entities: entities.filter((e, i) => entities.findIndex((x) => x.id === e.id) === i), matched: top.match.matched };
    }
    void spec;
    return { kind: "one", entity: top.entity, match: top.match, alias: top.alias };
  }

  private applyEntity(spec: ParamSpec, resolved: Awaited<ReturnType<NaturalLanguageEngine["resolveEntity"]>>, args: Record<string, PlanArgument>, targets: TargetRef[], notes: PlanNote[], ambiguity: string[], ask: (c: Clarification) => void, raw?: string) {
    if (resolved.kind === "none") {
      if (raw !== undefined) ask({ kind: "choose", param: spec.name, code: "entity_not_found", message: `I couldn't find "${raw}".`, vars: { param: spec.name, value: raw }, options: [] });
      return;
    }
    if (resolved.kind === "many") {
      ambiguity.push(spec.name);
      ask({ kind: "choose", param: spec.name, code: "choose_entity", message: `Which ${spec.entityKind} did you mean?`, vars: { param: spec.name }, options: resolved.entities.slice(0, 8).map((e) => ({ value: e.id, label: e.label })) });
      return;
    }
    const corrected = resolved.match.corrections.length > 0;
    args[spec.name] = { value: resolved.entity.id, source: "input", raw, display: resolved.entity.label, corrected };
    targets.push({ param: spec.name, kind: spec.entityKind!, id: resolved.entity.id, label: resolved.entity.label, via: "input" });
    if (resolved.partial) notes.push(note("assumption", "entity_partial", `Took "${raw ?? ""}" to mean "${resolved.entity.label}".`, { from: raw ?? "", to: resolved.entity.label }));
    if (corrected) {
      const kind = resolved.match.corrections.every((c) => c.kind === "homophone") ? "homophone" : "typo";
      notes.push(note(kind, `entity_${kind}`, `Read "${raw ?? ""}" as "${resolved.entity.label}".`, { from: raw ?? "", to: resolved.entity.label }));
    }
  }

  private chooseEntity(spec: ParamSpec, list: readonly EntityCandidate[], code: string, message: string): Clarification {
    return { kind: "choose", param: spec.name, code, message, options: list.slice(0, 8).map((e) => ({ value: e.id, label: e.label })) };
  }

  private async missing(spec: ParamSpec, listFor: (kind: string) => Promise<readonly EntityCandidate[]>): Promise<Clarification> {
    let options: ClarificationOption[] = [];
    if (spec.type === "entity") options = (await listFor(spec.entityKind!)).slice(0, 8).map((e) => ({ value: e.id, label: e.label }));
    else if (spec.type === "enum" || spec.type === "boolean") options = (spec.options ?? []).map((o) => ({ value: o.value, label: o.value }));
    return { kind: "missing", param: spec.name, code: "missing_param", message: spec.description ? `${spec.description}?` : `What ${spec.name}?`, vars: { param: spec.name }, options, freeText: spec.type === "text" || spec.type === "number" || spec.type === "money" || spec.type === "date" || spec.type === "dateRange" };
  }

  private fromContext(spec: ParamSpec, ctx: ParseContext, history: readonly HistoryTurn[]): ContextValue | null {
    for (let i = history.length - 1; i >= 0; i--) {
      const plan = history[i].plan;
      const definition = plan.intent && this.registry.get(plan.intent.actionId);
      if (!definition) continue;
      for (const other of definition.params) {
        if (other.contextKey !== spec.contextKey || other.type !== spec.type) continue;
        const argument = plan.arguments[other.name];
        if (argument && argument.source !== "default") return { value: argument.value, display: argument.display ?? (typeof argument.value === "string" ? argument.value : undefined) };
      }
    }
    const focus = ctx.focus?.[spec.contextKey!];
    return focus ?? null;
  }

  /** "and last month too" / "改成交通": no command words, but parameters for the previous action. */
  private async followUp(shared: Shared, ctx: ParseContext, opts: InterpretOptions, base: ActionPlan): Promise<ActionPlan | null> {
    const previous = opts.history?.at(-1)?.plan;
    if (!previous?.intent) return null;
    const definition = this.registry.get(previous.intent.actionId);
    if (!definition) return null;
    const empty: PhraseMatch = { quality: 1, matched: [], first: 0, last: 0, corrections: [] };
    const fresh = await this.extract(definition, empty, shared, ctx, { ...opts, answers: {} });
    const given = Object.entries(fresh.args).filter(([name, a]) => a.source === "input" && definition.params.find((p) => p.name === name)?.type !== "text");
    // Only structured values (dates, options, entities, amounts) can continue a command; free text cannot.
    if (!given.length || fresh.fit < 0.6) return null;
    const answers: Record<string, PlanArgument> = {};
    for (const [name, argument] of Object.entries(previous.arguments)) if (argument.source !== "default") answers[name] = { ...argument, source: "context" };
    for (const [name, argument] of given) answers[name] = argument;
    const plan = await this.interpret(previous.input, ctx, { actionId: definition.id, answers, history: opts.history, intentConfirmed: true });
    const merged: ActionPlan = { ...plan, planId: base.planId, input: base.input, language: base.language, notes: [note("followUp", "follow_up", `Continuing "${previous.input}".`, { previous: previous.input }), ...plan.notes] };
    if (definition.risk === "high" && merged.status === "ready") {
      merged.status = "needs_clarification";
      merged.clarification = { kind: "confirmIntent", code: "confirm_follow_up", message: `Do you want to: ${definition.description}?`, vars: { action: definition.id }, options: yesNo() };
      merged.ambiguity = { ambiguous: true, reasons: ["follow_up_high_risk"] };
    }
    return merged;
  }

  private async fromFallback(input: string, ctx: ParseContext, opts: InterpretOptions, base: ActionPlan): Promise<ActionPlan | null> {
    if (!this.options.fallback) return null;
    let proposal;
    try {
      proposal = await this.options.fallback.propose(input, this.registry.manifest());
    } catch {
      return null; // a failing optional component never breaks parsing
    }
    if (!proposal || !this.registry.get(proposal.actionId)) return null;
    const answers: Record<string, PlanArgument> = {};
    for (const [name, value] of Object.entries(proposal.arguments)) answers[name] = { value, source: "input" };
    const plan = await this.interpret(input, ctx, { ...opts, actionId: proposal.actionId, answers });
    const definition = this.registry.get(proposal.actionId)!;
    // A proposal is never trusted on its own: data-changing proposals always ask first.
    const reviewed: ActionPlan = { ...plan, planId: base.planId, notes: [note("assumption", "fallback_proposal", "Interpreted by the optional assistant; please check it."), ...plan.notes] };
    if (definition.risk !== "none" && reviewed.status === "ready") {
      reviewed.status = "needs_clarification";
      reviewed.clarification = { kind: "confirmIntent", code: "confirm_fallback", message: `Do you want to: ${definition.description}?`, vars: { action: definition.id }, options: yesNo() };
      reviewed.ambiguity = { ambiguous: true, reasons: ["fallback"] };
    }
    return reviewed;
  }

  // ---------- small helpers ----------

  private isStop(tokens: readonly Token[], index: number): boolean {
    return this.stopwords.some((phrase) => phrase.length === 1 ? phrase[0].text === tokens[index].text : false);
  }

  /** Drops stopword phrases at both ends of a token-index run. */
  private trimStop(tokens: readonly Token[], indices: number[]): number[] {
    const out = [...indices];
    const matchesAt = (position: number, phrase: Token[], fromEnd: boolean) => {
      const slice = fromEnd ? out.slice(out.length - phrase.length) : out.slice(0, phrase.length);
      return slice.length === phrase.length && slice.every((idx, k) => tokens[idx].text === phrase[k].text) && (slice.every((idx, k) => k === 0 || idx === slice[k - 1] + 1)) && position >= 0;
    };
    let changed = true;
    while (changed && out.length) {
      changed = false;
      for (const phrase of this.stopwords) {
        if (matchesAt(0, phrase, false)) { out.splice(0, phrase.length); changed = true; break; }
        if (matchesAt(0, phrase, true)) { out.splice(out.length - phrase.length, phrase.length); changed = true; break; }
      }
    }
    return out;
  }

  private removePhrases(tokens: readonly Token[], indices: number[], phrases: Token[][], used: boolean[]) {
    for (const phrase of phrases) {
      for (let s = 0; s + phrase.length <= indices.length; s++) {
        const slice = indices.slice(s, s + phrase.length);
        const same = (a: Token, b: Token) => a.text === b.text || (a.kind === "word" && b.kind === "word" && b.text.length >= 6 && editDistance(a.text, b.text, 1) <= 1);
        if (slice.every((idx, k) => same(tokens[idx], phrase[k]) && (k === 0 || idx === slice[k - 1] + 1))) for (const idx of slice) used[idx] = true;
      }
    }
  }

  private typedPhrase(definition: ActionDefinition, args: Record<string, PlanArgument>): string | null {
    if (confirmationFor(definition) !== "typed") return null;
    const param = definition.typedConfirmationParam;
    const argument = param ? args[param] : undefined;
    if (argument) return argument.display ?? String(argument.value);
    return "CONFIRM";
  }

  private emptyPlan(input: string, language: ActionPlan["language"], ctx: ParseContext): ActionPlan {
    return {
      protocol: PROTOCOL_VERSION, planId: this.newId(), createdAt: (ctx.now ?? new Date()).toISOString(), input, language, status: "unsupported",
      intent: null, alternatives: [], arguments: {}, targets: [], ambiguity: { ambiguous: false, reasons: [] }, clarification: null,
      operations: [], fingerprint: null, risk: "none", confirmation: "none", confirmationPhrase: null, notes: [], scope: { product: ctx.product, tenant: ctx.tenant }, issues: [],
    };
  }
}

const yesNo = (): ClarificationOption[] => [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const round = (n: number) => Math.round(n * 1000) / 1000;
const range = (from: number, to: number) => (to < from ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i));
const stripEdgePunctuation = (text: string) => text.replace(/^[\s,.;:!?，。；：！？、]+|[\s,.;:!?，。；：！？、]+$/gu, "");

/** Words, counting two Chinese characters as one word. */
function wordCount(text: string): number {
  const tokens = tokenize(normalize(text).text);
  return tokens.filter((t) => t.kind === "word" || t.kind === "number").length + Math.ceil(tokens.filter((t) => t.kind === "han" || t.kind === "kana").length / 2);
}

function longestRun(indices: number[]): number[] {
  let best: number[] = [];
  let current: number[] = [];
  for (const index of indices) {
    if (current.length && index !== current[current.length - 1] + 1) current = [];
    current.push(index);
    if (current.length > best.length) best = [...current];
  }
  return best;
}

export function formatRange(value: { start: string | null; end: string | null }): string {
  if (value.start && value.end) return value.start === value.end ? value.start : `${value.start} – ${value.end}`;
  if (value.start) return `${value.start} –`;
  if (value.end) return `– ${value.end}`;
  return "";
}

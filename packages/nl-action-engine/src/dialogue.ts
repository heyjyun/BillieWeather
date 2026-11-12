// Bounded multi-turn conversation: clarification answers, follow-ups and references to earlier turns.

import type { ParseContext } from "./adapter";
import type { HistoryTurn, NaturalLanguageEngine } from "./engine";
import { matchPhrase } from "./fuzzy";
import type { ActionPlan, ArgumentValue, Clarification, PlanArgument } from "./protocol";
import { normalize, parseLooseNumber, tokenize } from "./text";

export interface DialogueOptions {
  /** Earlier turns kept for references ("them"). */
  maxTurns?: number;
  /** Turns older than this are forgotten. */
  ttlMs?: number;
  clock?: () => number;
}

const CANCEL = new Set(["cancel", "never mind", "nevermind", "forget it", "stop", "abort", "no thanks", "取消", "算了", "不用了", "停", "停止", "不要了"]);
const YES = new Set(["yes", "y", "yeah", "yep", "sure", "ok", "okay", "confirm", "do it", "go ahead", "是", "是的", "对", "好", "好的", "确认", "确定", "可以", "行"]);
const NO = new Set(["no", "n", "nope", "不", "不是", "否", "不对", "不行"]);
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, last: -1 };

const fold = (text: string) => normalize(text).text.replace(/[.!?。！？]+$/u, "").trim();

export function isCancel(text: string): boolean { return CANCEL.has(fold(text)); }
export function isYes(text: string): boolean { return YES.has(fold(text)); }
export function isNo(text: string): boolean { return NO.has(fold(text)); }

/** Reads "2", "the second one", "第二个", or an option's label (typo tolerant). Null if unclear. */
export function chooseOption(clarification: Clarification, answer: string): string | null {
  const options = clarification.options;
  if (!options.length) return null;
  const text = fold(answer);
  const index = (() => {
    const digits = text.match(/^(?:#|no\.?|number|option|选项|第)?\s*(\d{1,2}|[一二三四五六七八九十])\s*(?:个|项|条|笔|号)?$/u);
    if (digits) return parseLooseNumber(digits[1]);
    const words = text.replace(/^the\s+/, "").replace(/\s+(?:one|option)$/, "");
    if (words in ORDINALS) return ORDINALS[words];
    const zh = text.match(/^第([一二三四五六七八九十]|\d+)(?:个|项|条|笔)?$/u);
    if (zh) return parseLooseNumber(zh[1]);
    if (text === "最后一个" || text === "最后") return -1;
    return null;
  })();
  if (index !== null) {
    const position = index === -1 ? options.length - 1 : index - 1;
    return options[position]?.value ?? null;
  }
  const answerTokens = tokenize(text);
  let best: { value: string; quality: number } | null = null;
  let tie = false;
  for (const option of options) {
    for (const label of [option.label, option.value]) {
      const pattern = tokenize(normalize(label).text);
      const match = matchPhrase(pattern, answerTokens, { phonetic: { readings: () => [] } });
      if (!match || match.matched.length !== pattern.length || match.quality < 0.7) continue;
      // The answer should be mostly the label, not a sentence that happens to contain it.
      if (answerTokens.length > pattern.length + 2) continue;
      if (!best || match.quality > best.quality) { tie = false; best = { value: option.value, quality: match.quality }; }
      else if (match.quality === best.quality && best.value !== option.value) tie = true;
    }
  }
  return best && !tie ? best.value : null;
}

interface Pending {
  plan: ActionPlan;
  answers: Record<string, PlanArgument>;
  actionId?: string;
  intentConfirmed?: boolean;
}

export class DialogueSession {
  private turns: HistoryTurn[] = [];
  private pending: Pending | null = null;
  private readonly maxTurns: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(readonly engine: NaturalLanguageEngine, options: DialogueOptions = {}) {
    this.maxTurns = options.maxTurns ?? 6;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Earlier turns still in scope, newest last. */
  history(): HistoryTurn[] {
    const now = this.clock();
    this.turns = this.turns.filter((t) => now - t.at <= this.ttlMs).slice(-this.maxTurns);
    return [...this.turns];
  }

  get awaiting(): ActionPlan | null {
    return this.pending?.plan ?? null;
  }

  /** Interprets a new message: a cancel, an answer to the open question, or a new command. */
  async submit(input: string, ctx: ParseContext): Promise<ActionPlan> {
    const pending = this.pending;
    if (pending && isCancel(input)) {
      this.pending = null;
      return { ...pending.plan, status: "cancelled", clarification: null };
    }
    if (pending?.plan.clarification) {
      const answered = await this.answer(pending, input, ctx);
      if (answered) return this.settle(answered);
      // Not an answer: maybe a new command. Otherwise keep asking.
      const fresh = await this.engine.interpret(input, ctx, { history: this.history() });
      if (fresh.intent) {
        this.pending = null;
        return this.settle(fresh);
      }
      return { ...pending.plan, notes: [...pending.plan.notes, { kind: "assumption", code: "answer_not_understood", message: "I didn't understand that answer." }] };
    }
    return this.settle(await this.engine.interpret(input, ctx, { history: this.history() }));
  }

  /** Applies edits from the structured preview. */
  async edit(plan: ActionPlan, edits: Record<string, ArgumentValue | null>, ctx: ParseContext): Promise<ActionPlan> {
    return this.settle(await this.engine.revise(plan, edits, ctx, this.history()));
  }

  /** Remembers a plan the person acted on (executed, or a read that was shown), for later references. */
  remember(plan: ActionPlan): void {
    if (!plan.intent) return;
    this.turns.push({ plan, at: this.clock() });
    this.history();
  }

  reset(): void {
    this.turns = [];
    this.pending = null;
  }

  private settle(plan: ActionPlan): ActionPlan {
    if (plan.status === "needs_clarification" && plan.clarification) {
      const previous = this.pending?.plan.input === plan.input ? this.pending : null;
      this.pending = { plan, answers: previous?.answers ?? {}, actionId: plan.intent?.actionId, intentConfirmed: previous?.intentConfirmed };
    } else {
      this.pending = null;
    }
    return plan;
  }

  private async answer(pending: Pending, input: string, ctx: ParseContext): Promise<ActionPlan | null> {
    const clarification = pending.plan.clarification!;
    const history = this.history();
    if (clarification.kind === "confirmIntent") {
      if (isYes(input)) {
        this.pending = { ...pending, intentConfirmed: true };
        return this.engine.interpret(pending.plan.input, ctx, { actionId: pending.actionId, answers: pending.answers, history, intentConfirmed: true });
      }
      if (isNo(input)) {
        this.pending = null;
        return { ...pending.plan, status: "cancelled", clarification: null };
      }
      return null;
    }
    if (clarification.kind === "intent") {
      const actionId = chooseOption(clarification, input);
      if (!actionId) return null;
      this.pending = { ...pending, actionId };
      return this.engine.interpret(pending.plan.input, ctx, { actionId, answers: pending.answers, history, intentConfirmed: true });
    }
    const param = clarification.param;
    if (!param || !pending.actionId) return null;
    let value: ArgumentValue | null = chooseOption(clarification, input);
    if (value === null) {
      // Free answers are parsed in the context of the original command; text is taken verbatim.
      const definition = this.engine.registry.get(pending.actionId);
      const spec = definition?.params.find((p) => p.name === param);
      if (spec?.type === "text") value = clarification.freeText ? input.trim() : null;
      else if (spec) {
        const reparsed = await this.engine.interpret(input, ctx, { actionId: pending.actionId, answers: {}, history });
        const argument = reparsed.arguments[param];
        if (argument && argument.source === "input") value = argument.value;
      }
    }
    if (value === null || value === "") return null;
    const answers = { ...pending.answers, [param]: { value, source: "clarification" as const, raw: input.trim() } };
    this.pending = { ...pending, answers };
    return this.engine.interpret(pending.plan.input, ctx, { actionId: pending.actionId, answers, history, intentConfirmed: pending.intentConfirmed || clarification.kind !== "missing" ? true : undefined });
  }
}

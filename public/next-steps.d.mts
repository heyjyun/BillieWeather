export interface NextFacts {
  accounts: Array<{id: number; name: string; institution: string | null; pending: boolean; observation?: string; archived: boolean}>;
  transactions: number; latest?: string; statements: number; unclassified: number; duplicates: number; matches: number; budgets: number;
  remaining?: number | null; months: Record<string,number>; currency: string; forecastReady: boolean; shortfall?: string; scheduled: string[]; available: string[];
  recent: Array<{id:number; date:string; description:string; kind:string; cents:number}>;
}
export interface Suggestion { kind: string; label: string; key: string; detail: string; target: string; priority: number }
export interface Feedback { status: "accepted" | "deferred" | "dismissed" | "completed" | "invalidated"; until?: number }
export type AssistantState = {enabled?: boolean} & Record<string, Feedback | boolean | undefined>;
export function nextSteps(facts: NextFacts, page: string, state?: AssistantState, now?: number): Suggestion[];
export function resolvedChoices(facts: NextFacts,state: AssistantState): Array<[string,Feedback]>;
export function selectSuggestion(text: string,items: Suggestion[]): Suggestion[];
export function mountNext(root: HTMLElement, options: {facts: NextFacts; page: string; state: AssistantState; copy: Record<string,string>;
  choose(item: Suggestion): void; save(key: string, value: Feedback, expected?: Feedback): Promise<void>}): void;

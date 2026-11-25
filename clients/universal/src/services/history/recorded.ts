// The store the interface uses: every operation listed in policy.ts becomes one entry of the editing history.
import { FinanceStore } from "../store";
import { RECORDED_LEDGER, RECORDED_STORE } from "./policy";
import type { HistoryAction } from "./history";

type Policy = Readonly<Record<string, HistoryAction | ((...args: unknown[]) => HistoryAction | null) | undefined>>;

function wrap<T extends object>(target: T, policy: Policy, run: (action: HistoryAction, method: string, args: unknown[]) => Promise<unknown>, nested: Record<string, unknown> = {}): T {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === "string" && property in nested) return nested[property];
      const value = Reflect.get(object, property, object) as unknown;
      if (typeof value !== "function") return value;
      const rule = typeof property === "string" ? policy[property] : undefined;
      if (rule === undefined || typeof property !== "string") return value.bind(object);
      return (...args: unknown[]) => {
        const action = typeof rule === "function" ? rule(...args) : rule;
        return action === null ? (value as (...input: unknown[]) => unknown).apply(object, args) : run(action, property, args);
      };
    },
  });
}

type Methods = Record<string, (...args: unknown[]) => Promise<unknown>>;

export function recordedStore(store: FinanceStore): FinanceStore {
  const ledger = wrap(store.ledger, RECORDED_LEDGER as Policy, (action, method, args) => store.record(action, (scoped) => (scoped.ledger as unknown as Methods)[method](...args)));
  return wrap(store, RECORDED_STORE as Policy, (action, method, args) => store.record(action, (scoped) => (scoped as unknown as Methods)[method](...args)), { ledger });
}

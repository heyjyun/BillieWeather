import { createRoot } from "react-dom/client";
import { Overview } from "../src/overview/Overview";
import {
  position,
  type Action,
  type Context,
  type Scope,
  type Sources,
  type Projection,
} from "../src/overview/model";

const node = document.getElementById("financial-overview");
if (node) {
  const context: Context = JSON.parse(node.dataset.context!);
  const links: Record<Action, string> = JSON.parse(node.dataset.links!);
  const source = node.dataset.source!;
  const urlFor = (base: string, scope: Scope) => {
    const url = new URL(base, location.origin);
    url.searchParams.set("locale", context.locale);
    url.searchParams.set("currency", scope.currency);
    if (scope.account) url.searchParams.set("account_id", scope.account);
    url.searchParams.set("preset", scope.period.preset);
    if (scope.period.startDate && scope.period.endDate) {
      url.searchParams.set("start_date", scope.period.startDate);
      url.searchParams.set("end_date", scope.period.endDate);
    }
    return url;
  };
  function sources(scope: Scope): Sources {
    const request = async <T,>(section: keyof Sources): Promise<T> => {
      const url = urlFor(source, scope);
      url.searchParams.set("section", section);
      const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw Error(String(res.status));
      return res.json();
    };
    let pending: ReturnType<Sources["position"]> | undefined;
    const holdings: Sources["position"] = () =>
      (pending ??= request<Awaited<ReturnType<Sources["position"]>>>("position").catch((e) => {
        pending = undefined;
        throw e;
      }));
    return {
      flow: () => request("flow"),
      position: holdings,
      spending: () => request("spending"),
      recent: () => request("recent"),
      bills: () => request("bills"),
      budget: () => request("budget"),
      insight: () => request("insight"),
      forecast: async () => {
        const opening = position(await holdings()).available;
        if (opening === null) return [];
        return (await request<Projection[]>("forecast")).map((p) => ({ ...p, balance: opening + p.balance }));
      },
    };
  }
  createRoot(node).render(
    <Overview
      context={context}
      sources={sources}
      scopeChanged={(scope) => {
        history.replaceState(history.state, "", urlFor(location.pathname, scope));
      }}
      navigate={(action, scope, category, activity) => {
        const url =
          action === "transactions" ||
          (action === "report" && !scope.account && scope.currency === context.currency)
            ? urlFor(links[action], scope)
            : new URL(links[action], location.origin);
        url.searchParams.set("locale", context.locale);
        if (activity) url.searchParams.set("activity", activity);
        if (category) url.searchParams.set("category", category);
        location.assign(url.href);
      }}
    />,
  );
}

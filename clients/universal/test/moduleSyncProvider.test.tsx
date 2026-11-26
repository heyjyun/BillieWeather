// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModulesProvider, useModules } from "../src/hooks/useModules";
import { loadModulePreferences } from "../src/services/modulePreferences";
import { loadReplica, type ModuleMutation, type ModuleSnapshot } from "../src/services/moduleSync";

const A = "cc32ddab-f1c4-4598-bc48-1c280a110110";
const B = "acc0e7cb-f188-40a0-aaca-5dace6b1b7f1";
const choice = { sidebar_visible: true, enabled: true, revision: 1, changed_at: null, updated_by_device_id: null };
const snapshot = (account_id: string, on = false): ModuleSnapshot => ({
  format: 2, account_id, server_revision: on ? 1 : 0, defaults_version: 1, modules: on ? { budgets: choice } : {},
});

function Probe() {
  const modules = useModules();
  return <><output aria-label="budgets">{String(modules.inSidebar("budgets"))}</output>
    <output aria-label="usable">{String(modules.usable("budgets"))}</output>
    <output aria-label="sync">{modules.status}</output>
    <button onClick={() => modules.setSidebarVisible("budgets", true)}>Show budgets</button></>;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("retries the same request after an interrupted response and survives a restart", async () => {
  let latest = false;
  const requests: ModuleMutation[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "PUT") {
      requests.push(JSON.parse(init.body as string));
      latest = true;
      if (requests.length === 1) throw new TypeError("connection interrupted");
      return Response.json({ ...snapshot(A, true), applied: ["budgets"], conflicts: [] });
    }
    return Response.json(snapshot(A, latest));
  }));
  const token = () => "session-a";
  const view = render(<ModulesProvider ownerKey="a" accountId={A} getToken={token}><Probe /></ModulesProvider>);
  await waitFor(() => expect(screen.getByLabelText("sync").textContent).toBe("synced"));
  fireEvent.click(screen.getByRole("button", { name: "Show budgets" }));
  await waitFor(() => expect(screen.getByLabelText("sync").textContent).toBe("error"));
  expect(loadReplica(A, loadModulePreferences("a")).pending[0].request).toEqual(requests[0]);
  view.unmount();

  render(<ModulesProvider ownerKey="a" accountId={A} getToken={token}><Probe /></ModulesProvider>);
  await waitFor(() => expect(requests).toHaveLength(2));
  await waitFor(() => expect(screen.getByLabelText("sync").textContent).toBe("synced"));
  expect(requests[0]).toEqual(requests[1]);
  expect(screen.getByLabelText("budgets").textContent).toBe("true");
  expect(screen.getByLabelText("usable").textContent).toBe("true");
  expect(loadReplica(A, loadModulePreferences("a")).pending).toEqual([]);
});

it("parks offline changes and ignores a response after logout and account switch", async () => {
  const requests: { token: string; signal: AbortSignal; method: string }[] = [];
  let finish: (reply: Response) => void = () => undefined;
  const tokenA = () => "session-a";
  const tokenB = () => "session-b";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const token = (init.headers as Record<string, string>).Authorization;
    requests.push({ token, signal: init.signal!, method: init.method! });
    if (init.method === "PUT") return new Promise<Response>((resolve) => { finish = resolve; });
    return Response.json(snapshot(token.endsWith("session-a") ? A : B));
  }));
  const view = render(<ModulesProvider key={A} ownerKey="a" accountId={A} getToken={tokenA} offline><Probe /></ModulesProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Show budgets" }));
  expect(requests).toHaveLength(0);
  expect(screen.getByLabelText("budgets").textContent).toBe("true");
  view.rerender(<ModulesProvider key={A} ownerKey="a" accountId={A} getToken={tokenA}><Probe /></ModulesProvider>);
  await waitFor(() => expect(loadReplica(A, loadModulePreferences("a")).conflicts.budgets?.kind).toBe("local_only"));
  // Use a synced cached state on the second pass so its edit sends a mutation.
  view.unmount();
  localStorage.clear();
  const next = render(<ModulesProvider key={A} ownerKey="a" accountId={A} getToken={tokenA}><Probe /></ModulesProvider>);
  await waitFor(() => expect(screen.getByLabelText("sync").textContent).toBe("synced"));
  fireEvent.click(screen.getByRole("button", { name: "Show budgets" }));
  await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
  next.rerender(<ModulesProvider key={B} ownerKey="b" accountId={B} getToken={tokenB}><Probe /></ModulesProvider>);
  await waitFor(() => expect(screen.getByLabelText("sync").textContent).toBe("synced"));
  expect(requests.find((r) => r.method === "PUT")?.signal.aborted).toBe(true);
  await act(async () => finish(Response.json({ ...snapshot(A, true), applied: ["budgets"], conflicts: [] })));
  expect(screen.getByLabelText("budgets").textContent).toBe("false");
  expect(screen.getByLabelText("usable").textContent).toBe("true"); // another account's sidebar, same usable features
  expect(loadReplica(A, loadModulePreferences("a")).pending).toHaveLength(1);
  expect(requests.filter((r) => r.token.endsWith("session-b")).every((r) => r.method === "GET")).toBe(true);
});

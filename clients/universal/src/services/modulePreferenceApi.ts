// Only format-2 visibility preferences leave this service. It never reads the ledger.
import { AccountError, API_ORIGIN, networkFailure } from "./account";
import type { ModuleMutation, ModuleSnapshot, MutationResult } from "./moduleSync";

const URL = API_ORIGIN + "/api/client/v1/module_preferences";

export class ModulePreferenceRequestError extends AccountError {
  constructor(public readonly status: number) {
    super(status === 401 ? "unauthorized" : status === 429 ? "rate_limited" : "unknown");
  }
}

async function request<T>(method: "GET" | "PUT", token: string, signal: AbortSignal, body?: ModuleMutation): Promise<T> {
  const requestController = new AbortController();
  const abort = () => requestController.abort();
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  try {
    const response = await fetch(URL, {
      method, signal: requestController.signal, cache: "no-store", credentials: "omit",
      headers: { Accept: "application/json", Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new ModulePreferenceRequestError(response.status);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ModulePreferenceRequestError) throw error;
    throw new AccountError(networkFailure());
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export const fetchModulePreferences = (token: string, signal: AbortSignal) =>
  request<ModuleSnapshot>("GET", token, signal);

export const putModulePreferences = (token: string, body: ModuleMutation, signal: AbortSignal) =>
  request<MutationResult>("PUT", token, signal, body);

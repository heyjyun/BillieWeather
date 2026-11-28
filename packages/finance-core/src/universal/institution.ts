import type { AccountType } from "../ledger/domain";
import type { PlannedStatement } from "./pipeline";

/** An integration receives an opaque consent handle from its platform host. The host retains
 * credentials. An adapter may read only the capabilities granted in that consent. */
export interface InstitutionConsent {
  provider: string;
  handle: string;
  capabilities: ReadonlyArray<"accounts" | "balances" | "transactions">;
}
export interface InstitutionSnapshot {
  providerAccountRef: string;
  institution: string;
  name: string | null;
  type: AccountType | null;
  currency: string | null;
  last4: string | null;
  balance: { signedMinor: number; observedOn: string } | null;
}
export interface InstitutionReader {
  readonly provider: string;
  read(consent: InstitutionConsent, cursor: string | null, signal: AbortSignal): Promise<{
    accounts: InstitutionSnapshot[];
    statements: PlannedStatement[];
    nextCursor: string | null;
  }>;
}
// Activation requires an authorized read-only provider and an approved platform consent flow.
export const institutionReaders: readonly InstitutionReader[] = Object.freeze([]);

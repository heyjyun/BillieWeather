export interface ReviewedAccount {
  name: string; type: string; institution: string; currency: string; last4: string; date: string; amount: string; origins?: Record<string,string>;
}
export interface AccountBatch { key: string; rows: ReviewedAccount[]; source: "text" | "screenshot"; confirmed: true }
export function mountCapture(root: HTMLElement, options: {
  suggestion?: string; copy: Record<string,string>; types: Record<string,string>; currency: string; region: string; empty: boolean; add: string;
  accounts: Array<{name: string; institution: string | null; type: string; last4: string | null}>;
  id(): string; recognize?: (file: File) => Promise<string>; commit(batch: AccountBatch): Promise<void>;
  statement(): void; manual(): void;
}): () => void;

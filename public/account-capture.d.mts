export const institutions: Record<string, string[]>;
export function institutionIn(text: string): string;
export function isDebt(type: string): boolean;
export function proposeAccounts(input: string, screenshot?: boolean): Array<{type: string; institution: string; last4: string; date: string; currency: string; amount: string}>;

export interface SearchableSelectOption {
  value: string;
  label: string;
  terms?: string;
  disabled?: boolean;
}

export function connectSearchableSelect(root: HTMLElement): {
  update(options: readonly SearchableSelectOption[], value: string): void;
  reset(): void;
  disconnect(): void;
};

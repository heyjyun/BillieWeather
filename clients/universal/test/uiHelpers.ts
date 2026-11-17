import { waitFor } from "@testing-library/react";

/** Navigation can load a page asynchronously; wait for its actual file control. */
export function findFileInput(): Promise<HTMLInputElement> {
  return waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("The file picker has not loaded yet.");
    return input;
  });
}

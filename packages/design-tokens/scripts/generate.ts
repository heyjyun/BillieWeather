// Writes the generated token stylesheets. Run from the repository root or this package:
//   node packages/design-tokens/scripts/generate.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderCss } from "../src/tokens.ts";

export const OUTPUTS = [
  "../dist/tokens.css", // universal client (imported by clients/universal/src/styles.css)
  "../../../public/billie-tokens.css", // Rails website (linked by app/views/layouts/billie.html.erb)
];

const css = renderCss();
for (const relative of OUTPUTS) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  writeFileSync(path, css);
  console.log(`wrote ${path}`);
}

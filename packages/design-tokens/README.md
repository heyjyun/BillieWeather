# @billie/design-tokens

The single source of truth for BillieWeather's visual design, shared by every surface:

| Surface | How it consumes the tokens |
| --- | --- |
| Rails website (`app/views`, `public/billie.css`) | `public/billie-tokens.css`, linked before `billie.css` in `app/views/layouts/billie.html.erb` |
| Universal client: macOS, Windows, iOS, Android, browser preview (`clients/universal`) | `dist/tokens.css`, imported at the top of `src/styles.css`; TypeScript can `import { icons, color } from "@billie/design-tokens"` |

`src/tokens.ts` defines semantic colors for a light and a dark theme (page, surfaces, borders, text,
the purple sidebar, the pink brand accent, positive/negative/warning/info financial states, the chart
palette), the type scale, spacing (4px grid), radii, shadows, layout sizes (sidebar, touch targets),
breakpoints, motion and the shared icon paths. Plain TypeScript, no dependencies.

## Changing a token

```sh
# edit packages/design-tokens/src/tokens.ts, then
node packages/design-tokens/scripts/generate.ts   # rewrites dist/tokens.css and public/billie-tokens.css
cd clients/universal && npx vitest run ../../packages/design-tokens
```

Never edit the generated CSS files. `test/tokens.test.ts` fails when:

- a generated file is out of date with `tokens.ts`;
- the light and dark themes define different keys;
- any text/background pair in `contrastPairs` falls below its WCAG minimum (4.5:1 for text, 3:1 for focus rings and indicators);
- the website or the app stops loading the generated tokens;
- the website's icon helper (`FinanceHelper#finance_icon`) draws a different path than `icons`.

## Using tokens in CSS

Custom properties are named `--bw-color-*`, `--bw-font-size-*`, `--bw-space-*`, `--bw-radius-*`,
`--bw-shadow-*`, plus `--bw-sidebar-width`, `--bw-tap-target`, etc. Use semantic colors, not raw hex:

- `accent` (#E458A3) is the brand pink for marks, indicators and charts. It is only 3.4:1 on white,
  so text links and primary buttons use `accent-strong` (#C2357F, 5.1:1).
- `positive-text` / `negative-text` are for money figures; `positive` / `negative` for chart marks.
  Never rely on color alone: amounts also carry a sign, badges a label or dot.
- `warning-*` marks rows that need review, uncertain data and stale results; `info-*` explains
  estimates and limitations (for example the forecast caveat).

## Themes

The tokens follow the operating system (`prefers-color-scheme`). `<html data-theme="light">` or
`data-theme="dark"` forces one. The choice is stored per device only:

- website: `localStorage["billie.theme"]`, applied before first paint by `public/billie-theme.js`, chosen from the theme menu in the header;
- apps: the same key, set from **Settings → Appearance** (`clients/universal/src/services/theme.ts`).

Neither is sent to the server. The collapsed-sidebar choice is stored the same way (`billie.sidebar`).

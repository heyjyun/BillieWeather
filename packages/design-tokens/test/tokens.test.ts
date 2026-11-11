import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { color, contrastPairs, contrastRatio, renderCss, type ThemeName } from "../src/tokens";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("design tokens", () => {
  it("generated stylesheets match the token source (run `node packages/design-tokens/scripts/generate.ts`)", () => {
    const css = renderCss();
    expect(read("../dist/tokens.css")).toBe(css);
    expect(read("../../../public/billie-tokens.css")).toBe(css);
  });

  it("both themes define the same keys", () => {
    expect(Object.keys(color.dark).sort()).toEqual(Object.keys(color.light).sort());
  });

  for (const theme of ["light", "dark"] as ThemeName[]) {
    it(`${theme} theme meets the required WCAG contrast for every text pair`, () => {
      const failures = contrastPairs
        .map(({ fg, bg, min }) => ({ fg, bg, min, ratio: contrastRatio(color[theme][fg], color[theme][bg]) }))
        .filter(({ ratio, min }) => ratio < min)
        .map(({ fg, bg, min, ratio }) => `${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
      expect(failures).toEqual([]);
    });
  }

  it("the website and the app consume the generated tokens instead of redefining the palette", () => {
    const layout = read("../../../app/views/layouts/billie.html.erb");
    expect(layout.indexOf("/billie-tokens.css")).toBeGreaterThan(-1);
    expect(layout.indexOf("/billie-tokens.css")).toBeLessThan(layout.indexOf('"/billie.css"'));
    expect(read("../../../clients/universal/src/styles.css")).toMatch(/@import ["'].*design-tokens\/dist\/tokens\.css["']/);
  });
});

describe("shared icons", () => {
  it("the website's icon helper draws the same paths as the shared icon set", async () => {
    const { icons } = await import("../src/tokens");
    const helper = read("../../../app/helpers/finance_helper.rb");
    for (const name of ["dashboard", "upload", "transactions", "forecast", "insights", "tag", "file", "settings", "lock", "sun"] as const) {
      expect(helper, name).toContain(`"${name}" => "${icons[name]}"`);
    }
  });
});

describe("engine compatibility", () => {
  // The apps target Safari 15 (iOS, older macOS WebKit) and Chrome 105 (Windows WebView2) — see
  // clients/universal/vite.config.ts. color-mix() needs Safari 16.2 / Chrome 111, so translucent
  // colors are plain rgba tokens instead.
  it.each(["../../../public/billie.css", "../../../clients/universal/src/styles.css", "../dist/tokens.css"])("%s avoids CSS newer than the supported engines", (file) => {
    const css = read(file);
    expect(css).not.toMatch(/color-mix\(|oklch\(|@container|@layer|text-wrap:/);
  });
});

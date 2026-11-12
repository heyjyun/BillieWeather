// The committed website outputs are generated from the shared sources and must stay in sync with
// them (like the design tokens): the bundle, its stylesheet and the manifest the Rails executor trusts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { webRegistry } from "@billie/commands";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("generated website outputs", () => {
  it("public/billie-command.* and the Rails manifest match a fresh build (run `node packages/billie-commands/scripts/build-web.mjs`)", async () => {
    // @ts-expect-error plain ESM build script without type declarations
    const { staleOutputs } = await import("../scripts/build-web.mjs");
    expect(await staleOutputs()).toEqual([]);
  }, 60_000);

  it("the manifest the Rails executor trusts is exactly the web registry", () => {
    expect(JSON.parse(read("../../../config/smart_command/web-manifest.json"))).toEqual(JSON.parse(JSON.stringify(webRegistry().manifest())));
  });

  it("the bundle contains no network calls other than the command endpoints", () => {
    const js = read("../../../public/billie-command.js");
    expect(js).not.toMatch(/https?:\/\/(?!(?:react\.dev|reactjs\.org|www\.w3\.org))/);
    expect(js).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
  });
});

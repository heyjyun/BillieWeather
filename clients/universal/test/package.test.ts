import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS build script
import { blockers } from "../scripts/package.mjs";

const release = { identifier: "com.billieweather.client", authority: "Developer ID Application: Example (TEAM)", hardened: true, notarized: true, stapled: true, gatekeeper: true, getTaskAllow: false };

describe("release gates", () => {
  it("accepts only a complete release", () => expect(blockers(release)).toEqual([]));
  it.each([
    [{ authority: "adhoc" }], [{ authority: undefined }], [{ identifier: "com.billieweather.client.qa" }], [{ hardened: false }],
    [{ notarized: false }], [{ stapled: false }], [{ gatekeeper: false }], [{ getTaskAllow: true }],
  ])("is blocked by %o", (change) => expect(blockers({ ...release, ...change })).toHaveLength(1));
});

// Dev builds can never be the shipped (Stable) app (scripts/tauri.mjs, src-tauri/src/variant.rs).
// There are two app versions: Stable (com.billieweather.client) and Dev (com.billieweather.client.dev).
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain JS build script
import { assertReleaseOrigins, assertVariantOrigins, buildVariant, developmentIdentity } from "../scripts/tauri.mjs";

const ROOT = join(__dirname, "..");
const base = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));

describe("Dev and Stable build variants", () => {
  it("gives desktop:dev its own identity, so it never opens the shipped app's ledgers", () => {
    expect(developmentIdentity("dev").identifier).toBe("com.billieweather.client.dev");
    expect(developmentIdentity("build")).toEqual({});
    expect(base.identifier).toBe("com.billieweather.client");
  });

  it("builds the installed Dev app under the Dev identity, against local servers only", () => {
    expect(developmentIdentity("build", "dev")).toMatchObject({ identifier: "com.billieweather.client.dev", productName: "BillieWeather Dev" });
    expect(developmentIdentity("build", "stable")).toEqual({});
    expect(buildVariant(undefined)).toBe("stable");
    expect(buildVariant(undefined, "dev")).toBe("dev");
    expect(buildVariant("stable", "dev")).toBe("dev");
    expect(() => buildVariant("prod")).toThrow(/BILLIE_VARIANT/);
    expect(() => buildVariant("qa")).toThrow(/BILLIE_VARIANT/);
    const local = { BILLIE_API_URL: "http://localhost:3000", BILLIE_IDENTITY_URL: "http://localhost:8100" };
    expect(() => assertVariantOrigins("dev", local)).not.toThrow();
    expect(() => assertVariantOrigins("dev", { ...local, BILLIE_API_URL: "https://web-68wd.onrender.com" })).toThrow(/non-local/);
    expect(() => assertVariantOrigins("stable", { ...local, BILLIE_API_URL: "https://web-68wd.onrender.com" })).not.toThrow();
    expect(() => assertReleaseOrigins("build", local)).toThrow(/Refusing/);
  });

  it("has no QA build script or QA identifier left", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(Object.values(scripts).some((command) => command.includes("qa.mjs"))).toBe(false);
    expect(readFileSync(join(ROOT, "src-tauri/src/variant.rs"), "utf8")).not.toMatch(/is_qa|\.qa"/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS build script
import { blockers } from "../scripts/package.mjs";

// @ts-expect-error plain JS build script
import { buildNumber } from "../scripts/tauri.mjs";
import viteConfig from "../vite.config";

const file = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
const release = { identifier: "com.billieweather.client", authority: "Developer ID Application: Example (TEAM)", hardened: true, notarized: true, stapled: true, gatekeeper: true, getTaskAllow: false };

describe("release gates", () => {
  it("accepts only a complete release", () => expect(blockers(release)).toEqual([]));
  it.each([
    [{ authority: "adhoc" }], [{ authority: undefined }], [{ identifier: "com.billieweather.client.qa" }], [{ hardened: false }],
    [{ notarized: false }], [{ stapled: false }], [{ gatekeeper: false }], [{ getTaskAllow: true }],
  ])("is blocked by %o", (change) => expect(blockers({ ...release, ...change })).toHaveLength(1));
});

describe("version", () => {
  it("comes from package.json everywhere", () => {
    const version = JSON.parse(file("package.json")).version as string;
    const [, plain, beta] = /^(\d+\.\d+\.\d+)(?:-beta\.([1-9]\d*))?$/.exec(version) ?? [];
    expect(plain).toBeTruthy();
    // MSI knows no "-beta": the fourth number is the beta (an MSI of the release itself has none).
    expect(JSON.parse(file("src-tauri/tauri.conf.json")).bundle.windows.wix.version).toBe(beta ? `${plain}.${beta}` : plain);
    expect(JSON.parse(file("src-tauri/tauri.conf.json")).version).toBe("../package.json");
    expect(/^version = "(.*)"$/m.exec(file("src-tauri/Cargo.toml"))?.[1]).toBe(version);
    expect(JSON.parse(file("package-lock.json")).version).toBe(version);
  });
  it.each(["", "0", "fatal", "12a", undefined])("has no build number from %o", (count) => expect(() => buildNumber(count)).toThrow());
  it("counts commits", () => expect(buildNumber("318")).toBe("318"));
});

describe("mobile privacy and permissions", () => {
  it("explains the camera and photos on iOS, which ends the app otherwise", () => {
    for (const key of ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"]) expect(file("src-tauri/Info.ios.plist")).toMatch(new RegExp(`<key>${key}</key>\\s*<string>[^<]{10,}</string>`));
  });
  it("keeps the ledger out of Android cloud backups and device transfers", () => {
    const manifest = file("src-tauri/plugins/billie-ocr/android/src/main/AndroidManifest.xml");
    for (const setting of ['android:allowBackup="false"', 'android:fullBackupContent="false"', 'android:dataExtractionRules="@xml/billie_no_extraction"']) expect(manifest).toContain(setting);
    const rules = file("src-tauri/plugins/billie-ocr/android/src/main/res/xml/billie_no_extraction.xml");
    for (const domain of ["root", "file", "database", "sharedpref", "external"]) expect(rules.split(`<exclude domain="${domain}" />`)).toHaveLength(3);
  });
});

describe("build configuration", () => {
  // Without an inline PostCSS config, Vite searches parent folders for one and can reach the Rails
  // postcss.config.js at the repository root, which runs `bundle exec bin/theme`. That failed every
  // Windows CI build (GitHub run 45253715553). An inline object turns the file search off.
  it("gives PostCSS inline, so the website's config is never loaded", () => {
    const config = viteConfig as { css?: { postcss?: unknown } };
    expect(config.css?.postcss).toEqual({ plugins: [] });
  });
});

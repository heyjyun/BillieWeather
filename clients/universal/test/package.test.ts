import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS build script
import { blockers } from "../scripts/package.mjs";

// @ts-expect-error plain JS build script
import { buildNumber } from "../scripts/tauri.mjs";

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
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
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

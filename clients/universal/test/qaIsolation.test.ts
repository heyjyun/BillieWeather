// QA and development builds can never be the shipped app (scripts/qa.mjs, scripts/tauri.mjs,
// src-tauri/src/variant.rs). See docs/audits/phase5.7-final-rc-acceptance.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain JS build script
import { problems, productionFiles, qaConfig, qaOrigin } from "../scripts/qa.mjs";
// @ts-expect-error plain JS build script
import { assertReleaseOrigins, assertVariantOrigins, buildVariant, developmentIdentity } from "../scripts/tauri.mjs";

const ROOT = join(__dirname, "..");
const base = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const API = "http://127.0.0.1:33557";
const IDENTITY = "http://127.0.0.1:38557";
const HOME = "/Users/someone";
const ID = "com.billieweather.client.qa";

function facts(change: (value: ReturnType<typeof good>) => void = () => undefined) {
  const value = good();
  change(value);
  return problems(value) as string[];
}

function good() {
  return {
    app: "/private/tmp/qa/BillieWeather QA.app",
    home: HOME,
    plist: { CFBundleIdentifier: ID, CFBundleName: "BillieWeather QA", CFBundleDisplayName: "BillieWeather QA", CFBundleURLTypes: [{ CFBundleURLSchemes: ["billieweather-qa"] }] } as Record<string, unknown>,
    signed: { valid: true, identifier: ID },
    report: {
      marker: "billie-launch-guard-version1", identifier: ID, bundleIdentifier: ID, productName: "BillieWeather QA", windowTitles: ["BillieWeather QA"], debug: false, devUrl: null as string | null,
      sourceRevision: "a".repeat(40), dataDir: `${HOME}/Library/Application Support/${ID}`, cacheDir: `${HOME}/Library/Caches/${ID}`, webkitDir: `${HOME}/Library/WebKit/${ID}`,
      preferences: `${HOME}/Library/Preferences/${ID}.plist`, keychainService: ID, connect: ["'self'", "ipc:", "http://ipc.localhost", API, IDENTITY], refusal: null as string | null,
    } as Record<string, unknown> | null,
  };
}

describe("QA build configuration", () => {
  it("replaces every place the shipped app's identity appears", () => {
    const config = qaConfig(base, "", API, IDENTITY);
    const merged = { ...base, ...config, app: { ...base.app, ...config.app }, plugins: { ...base.plugins, ...config.plugins } };
    expect(merged.identifier).toBe(ID);
    expect(merged.productName).toBe("BillieWeather QA");
    expect(merged.app.windows.map((w: { title: string }) => w.title)).toEqual(["BillieWeather QA"]);
    expect(merged.plugins["deep-link"].desktop.schemes).toEqual(["billieweather-qa"]);
    expect(merged.build.devUrl).toBeNull();
    expect(qaConfig(base, "upd1", API, IDENTITY).identifier).toBe(`${ID}.upd1`);
    for (const suffix of ["../x", "A", "a.b", "a b"]) expect(() => qaConfig(base, suffix, API, IDENTITY)).toThrow();
  });

  it("accepts only isolated loopback servers", () => {
    expect(qaOrigin(API, "x")).toBe(API);
    for (const value of [undefined, "", "https://example.com", "http://localhost:33557", "http://127.0.0.1:3000", "http://127.0.0.1:8100", "http://127.0.0.1:1420", "http://127.0.0.1", "http://10.0.0.2:33557", "http://127.0.0.1:33557/path"]) {
      expect(() => qaOrigin(value, "x"), String(value)).toThrow();
    }
  });

  it("gives desktop:dev its own identity, so it never opens the shipped app's ledgers", () => {
    expect(developmentIdentity("dev").identifier).toBe("com.billieweather.client.dev");
    expect(developmentIdentity("build")).toEqual({});
    expect(base.identifier).toBe("com.billieweather.client");
  });

  it("builds the installed Dev app under the Dev identity, against local servers only", () => {
    expect(developmentIdentity("build", "dev")).toMatchObject({ identifier: "com.billieweather.client.dev", productName: "BillieWeather Dev" });
    expect(developmentIdentity("build", "stable")).toEqual({});
    expect(buildVariant(undefined)).toBe("stable");
    expect(() => buildVariant("prod")).toThrow(/BILLIE_VARIANT/);
    const local = { BILLIE_API_URL: "http://localhost:3000", BILLIE_IDENTITY_URL: "http://localhost:8100" };
    expect(() => assertVariantOrigins("dev", local)).not.toThrow();
    expect(() => assertVariantOrigins("dev", { ...local, BILLIE_API_URL: "https://web-68wd.onrender.com" })).toThrow(/non-local/);
    expect(() => assertVariantOrigins("stable", { ...local, BILLIE_API_URL: "https://web-68wd.onrender.com" })).not.toThrow();
    expect(() => assertReleaseOrigins("build", local)).toThrow(/Refusing/);
  });
});

describe("QA preflight", () => {
  it("passes only a bundle that is QA in every respect", () => expect(facts()).toEqual([]));

  it.each<[string, (value: ReturnType<typeof good>) => void]>([
    ["shipped Info.plist", (v) => { v.plist.CFBundleIdentifier = "com.billieweather.client"; }],
    ["lookalike identifier", (v) => { v.plist.CFBundleIdentifier = "com.billieweather.client.qax"; }],
    ["binary compiled as the shipped app in a QA bundle (the 2026-11-24 incident)", (v) => { v.report!.identifier = "com.billieweather.client"; }],
    ["no launch guard in the binary", (v) => { v.report = null; }],
    ["debug build", (v) => { v.report!.debug = true; }],
    ["development server", (v) => { v.report!.devUrl = "http://localhost:1420/"; }],
    ["shipped data folder", (v) => { v.report!.dataDir = `${HOME}/Library/Application Support/com.billieweather.client`; }],
    ["shipped WebView storage", (v) => { v.report!.webkitDir = `${HOME}/Library/WebKit/com.billieweather.client`; }],
    ["shipped cache", (v) => { v.report!.cacheDir = `${HOME}/Library/Caches/com.billieweather.client`; }],
    ["shipped preferences", (v) => { v.report!.preferences = `${HOME}/Library/Preferences/com.billieweather.client.plist`; }],
    ["shipped keychain entry", (v) => { v.report!.keychainService = "com.billieweather.client"; }],
    ["remote server", (v) => { v.report!.connect = ["'self'", "https://billieweather.example.com"]; }],
    ["development API", (v) => { v.report!.connect = ["'self'", "http://127.0.0.1:3000"]; }],
    ["any server", (v) => { v.report!.connect = ["*"]; }],
    ["shipped URL scheme", (v) => { v.plist.CFBundleURLTypes = [{ CFBundleURLSchemes: ["billieweather"] }]; }],
    ["shipped name", (v) => { v.plist.CFBundleName = "BillieWeather"; }],
    ["shipped window title", (v) => { v.report!.windowTitles = ["BillieWeather"]; }],
    ["broken signature", (v) => { v.signed.valid = false; }],
    ["other signed identifier", (v) => { v.signed.identifier = "com.billieweather.client"; }],
    ["installed location", (v) => { v.app = "/Applications/BillieWeather QA.app"; }],
    ["unrecorded source", (v) => { v.report!.sourceRevision = "unrecorded"; }],
    ["guard refusal", (v) => { v.report!.refusal = "reason"; }],
  ])("fails closed: %s", (_name, change) => expect(facts(change).length).toBeGreaterThan(0));

  it("recognises files of the shipped app, and only those", () => {
    const L = `${HOME}/Library`;
    expect(productionFiles([`${L}/Application Support/com.billieweather.client/billieweather.db`, `${L}/Application Support/${ID}/billieweather.db`, `${L}/Preferences/com.billieweather.client.plist`, `${L}/Preferences/${ID}.plist`, `${L}/WebKit/com.billieweather.client`], HOME))
      .toEqual([`${L}/Application Support/com.billieweather.client/billieweather.db`, `${L}/Preferences/com.billieweather.client.plist`, `${L}/WebKit/com.billieweather.client`]);
  });
});

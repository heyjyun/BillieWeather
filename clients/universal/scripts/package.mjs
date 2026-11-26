#!/usr/bin/env node
// Packages a built macOS app as a DMG and checks every distribution gate.
//   node scripts/package.mjs <App.app> <output folder>
// Signing: BILLIE_SIGN_IDENTITY ("Developer ID Application: …"). Notarization: BILLIE_NOTARY_PROFILE
// (a profile stored with `xcrun notarytool store-credentials`). Without them the DMG is for QA only,
// the manifest says BLOCKED and the exit code is 2. An ad hoc signature never counts as a release.
// A QA build is packaged as it is. This script never starts or installs the app.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QA_IDENTIFIER } from "./qa.mjs";

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { ok: result.status === 0, text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};
const must = (label, result) => { if (!result.ok) throw new Error(`${label} failed: ${result.text}`); return result; };
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** What distribution still needs, from the facts about a package. Empty only for a real release. */
export function blockers({ identifier, authority, hardened, notarized, stapled, gatekeeper, getTaskAllow }) {
  const found = [];
  if (identifier !== "com.billieweather.client") found.push("not the release identifier (QA builds are never distributed)");
  if (!/^Developer ID Application: /.test(authority ?? "")) found.push("not signed with a Developer ID");
  if (!hardened) found.push("no hardened runtime");
  if (getTaskAllow) found.push("allows debugging (get-task-allow)");
  if (!notarized) found.push("not notarized");
  if (!stapled) found.push("no stapled ticket");
  if (!gatekeeper) found.push("Gatekeeper does not accept it");
  return found;
}

function main(path, folder) {
  const app = resolve(path);
  if (!app.endsWith(".app") || !existsSync(app) || lstatSync(app).isSymbolicLink() || realpathSync(app) !== app) throw new Error("Give the real path of an .app bundle");
  const plist = JSON.parse(must("Info.plist", run("plutil", ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")])).text);
  const identifier = plist.CFBundleIdentifier;
  const qa = QA_IDENTIFIER.test(identifier);
  if (!qa && identifier !== "com.billieweather.client") throw new Error("Unknown bundle identifier");
  if (existsSync(join(folder, `${basename(app, ".app")}-${plist.CFBundleShortVersionString}.dmg`))) throw new Error("The DMG already exists; nothing is overwritten");
  mkdirSync(folder, { recursive: true });
  const identity = process.env.BILLIE_SIGN_IDENTITY;
  const work = mkdtempSync(join(tmpdir(), "billie-dmg-"));
  try {
    const copy = join(work, "image", basename(app));
    mkdirSync(dirname(copy));
    must("Copy", run("ditto", [app, copy]));
    if (identity && !qa) must("Signing", run("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, "--identifier", identifier, copy]));
    if (!identity && !qa && !run("codesign", ["--verify", "--deep", "--strict", copy]).ok)
      must("Local signature", run("codesign", ["--force", "--sign", "-", "--timestamp=none", copy]));
    must("Signature", run("codesign", ["--verify", "--deep", "--strict", copy]));
    const details = run("codesign", ["-dvvv", copy]).text;
    const entitlements = run("codesign", ["-d", "--entitlements", "-", "--xml", copy]).text;
    run("ln", ["-s", "/Applications", join(work, "image", "Applications")]);
    const dmg = join(resolve(folder), `${basename(app, ".app")}-${plist.CFBundleShortVersionString}.dmg`);
    must("DMG", run("hdiutil", ["create", "-volname", basename(app, ".app"), "-srcfolder", join(work, "image"), "-format", "UDZO", "-fs", "HFS+", dmg]));
    if (identity && !qa) must("DMG signing", run("codesign", ["--timestamp", "--sign", identity, dmg]));
    const profile = process.env.BILLIE_NOTARY_PROFILE;
    const notarized = Boolean(identity && profile && !qa) && run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait"]).text.includes("status: Accepted");
    const stapled = notarized && run("xcrun", ["stapler", "staple", dmg]).ok;
    must("DMG check", run("hdiutil", ["verify", dmg]));
    const facts = {
      identifier,
      authority: /^Authority=(.*)$/m.exec(details)?.[1] ?? /^Signature=(.*)$/m.exec(details)?.[1],
      hardened: /flags=0x[0-9a-f]+\([^)]*runtime/.test(details),
      getTaskAllow: entitlements.includes("get-task-allow"),
      notarized, stapled,
      gatekeeper: run("spctl", ["--assess", "--type", "execute", copy]).ok && run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]).ok,
    };
    const executable = join(copy, "Contents/MacOS", plist.CFBundleExecutable);
    const manifest = {
      name: basename(dmg), version: plist.CFBundleShortVersionString, build: plist.CFBundleVersion, minimumSystem: plist.LSMinimumSystemVersion,
      architectures: run("lipo", ["-archs", executable]).text, dmgSha256: sha256(dmg), executableSha256: sha256(executable),
      cdHash: /^CDHash=(.*)$/m.exec(details)?.[1], entitlements: entitlements.includes("<dict>") ? entitlements : "none", ...facts, blockers: blockers(facts),
    };
    writeFileSync(`${dmg}.json`, JSON.stringify(manifest, null, 2) + "\n");
    console.log(JSON.stringify(manifest, null, 2));
    if (manifest.blockers.length) { console.error("RELEASE BLOCKED"); process.exitCode = 2; }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/package.mjs <App.app> <output folder>");
    main(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

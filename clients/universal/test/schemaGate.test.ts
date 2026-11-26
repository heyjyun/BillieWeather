// Audit A-01 / A-03: the app only uses a book at exactly its own schema version, and the version and
// slot count are the same on the Rust and TypeScript sides.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkSchemaVersion } from "../src/services/platform";
import { LOCAL_SCHEMA_VERSION } from "../src/services/backup";
import { MAX_DATABASES, openFailure } from "../src/services/databases";
import { MIGRATIONS_DIR } from "./helpers";

const answer = (version: number, applied: number) => async () => [{ version, applied }];

describe("schema version gate", () => {
  it("accepts a book at exactly this build's version", async () => {
    await expect(checkSchemaVersion(answer(LOCAL_SCHEMA_VERSION, LOCAL_SCHEMA_VERSION))).resolves.toBeUndefined();
  });

  it("refuses a newer book with the message the app shows as 'made by a newer version'", async () => {
    const error = await checkSchemaVersion(answer(LOCAL_SCHEMA_VERSION + 1, LOCAL_SCHEMA_VERSION + 1)).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(openFailure((error as Error).message)).toBe("newer");
  });

  it("refuses a book whose migrations were skipped or only partly applied", async () => {
    await expect(checkSchemaVersion(answer(LOCAL_SCHEMA_VERSION - 1, LOCAL_SCHEMA_VERSION - 1))).rejects.toThrow(/incomplete/);
    await expect(checkSchemaVersion(answer(LOCAL_SCHEMA_VERSION, LOCAL_SCHEMA_VERSION - 1))).rejects.toThrow(/incomplete/);
    await expect(checkSchemaVersion(async () => [])).rejects.toThrow(/incomplete/);
    const error = await checkSchemaVersion(answer(LOCAL_SCHEMA_VERSION - 1, LOCAL_SCHEMA_VERSION - 1)).catch((caught: Error) => caught);
    expect(openFailure((error as Error).message)).toBe("incomplete");
  });

  it("every app language explains an incomplete book and points to an automatic copy", async () => {
    const { MESSAGES: messages } = await import("../src/i18n");
    for (const [locale, copy] of Object.entries(messages)) {
      const text = (copy as { boot: { failure: Record<string, string> } }).boot.failure.incomplete;
      expect(text, locale).toBeTruthy();
      expect(text, locale).not.toBe((copy as { boot: { failure: Record<string, string> } }).boot.failure.other);
    }
  });
});

describe("Rust and TypeScript agree", () => {
  const lib = readFileSync(join(__dirname, "../src-tauri/src/lib.rs"), "utf8");

  it("on the schema version: migration files, lib.rs migrations and LOCAL_SCHEMA_VERSION", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    expect(files.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: files.length }, (_, i) => i + 1));
    const versions = [...lib.matchAll(/version:\s*(\d+),/g)].map((match) => Number(match[1]));
    expect(versions).toEqual(Array.from({ length: files.length }, (_, i) => i + 1));
    for (const file of files) expect(lib).toContain(`../migrations/${file}`);
    expect(LOCAL_SCHEMA_VERSION).toBe(files.length);
  });

  it("on the number of database slots", () => {
    expect(Number(lib.match(/const MAX_DATABASES: u32 = (\d+);/)?.[1])).toBe(MAX_DATABASES);
  });
});

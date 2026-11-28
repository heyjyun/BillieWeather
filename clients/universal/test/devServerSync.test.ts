// A running dev server and migration files that change underneath it (2026-11-28: a server started
// before 0011_category_hierarchy.sql existed kept serving 0001–0010, because vite.config.ts ignored all
// of src-tauri). These tests start a real Vite dev server on a throwaway folder and add, change, rename
// and remove migrations while it runs. Synthetic files only; nothing in the repository is touched.
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import config from "../vite.config";
import { devServerSync, ignoreTauriExceptMigrations, type DevServerStatus } from "../devServerSync";

describe("which paths the dev server watches", () => {
  it("watches src-tauri/migrations and nothing else under src-tauri", () => {
    for (const path of ["/app/src-tauri/migrations", "/app/src-tauri/migrations/0011_category_hierarchy.sql", "C:\\app\\src-tauri\\migrations\\0012_x.sql", "/app/src-tauri"]) {
      expect(ignoreTauriExceptMigrations(path), path).toBe(false);
    }
    for (const path of ["/app/src-tauri/src/lib.rs", "/app/src-tauri/target/debug/x", "/app/src-tauri/target-stable-local/a", "/app/src-tauri/migrations-old/x.sql", "C:\\app\\src-tauri\\target\\x"]) {
      expect(ignoreTauriExceptMigrations(path), path).toBe(true);
    }
    expect(ignoreTauriExceptMigrations("/app/src/services/platform.ts")).toBe(false);
  });

  it("is what the app's vite.config.ts uses, together with the sync plugin", () => {
    const resolved = typeof config === "function" ? null : config;
    expect(resolved?.server?.watch?.ignored).toEqual([ignoreTauriExceptMigrations]);
    const names = (resolved?.plugins ?? []).flat().map((plugin) => (plugin && typeof plugin === "object" && "name" in plugin ? plugin.name : null));
    expect(names).toContain("billie-dev-server-sync");
  });
});

describe("a dev server that is already running", () => {
  let root: string;
  let server: ViteDevServer;
  let sent: Array<{ type: string; [key: string]: unknown }>;
  const migrations = () => join(root, "src-tauri", "migrations");
  const write = (name: string, sql = `CREATE TABLE t_${name.slice(0, 4)} (id INTEGER);`) => writeFileSync(join(migrations(), name), sql);
  const base = () => `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
  /** The migration file names the app module currently gets from its import.meta.glob. */
  const served = async () => {
    const code = await (await fetch(`${base()}/src/main.ts`)).text();
    return [...code.matchAll(/migrations\/(\d{4}_[a-z_]+\.sql)/g)].map((match) => match[1]).filter((name, i, all) => all.indexOf(name) === i).sort();
  };
  const until = async <T>(read: () => Promise<T> | T, ok: (value: T) => boolean, timeout = 8000): Promise<T> => {
    const end = Date.now() + timeout;
    let value = await read();
    while (!ok(value)) {
      if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      value = await read();
    }
    return value;
  };
  const reloads = () => sent.filter((message) => message.type === "full-reload").length;
  const status = async () => (await (await fetch(`${base()}/__billie/dev-status`)).json()) as DevServerStatus;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "billie-devsync-")));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(migrations(), { recursive: true });
    mkdirSync(join(root, "src-tauri", "target"), { recursive: true });
    writeFileSync(join(root, "index.html"), '<!doctype html><script type="module" src="/src/main.ts"></script>');
    // The same glob as src/services/platform.ts, one folder up.
    writeFileSync(join(root, "src", "main.ts"), 'export const migrations = import.meta.glob("../src-tauri/migrations/*.sql", { query: "?raw", import: "default", eager: true });\n');
    writeFileSync(join(root, "package.json"), '{"name":"devsync-fixture","private":true}');
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    writeFileSync(join(root, "catalog.json"), '{"version":3,"modules":[]}');
    write("0001_initial.sql");
    write("0002_second.sql");
    server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      clearScreen: false,
      css: { postcss: { plugins: [] } },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { port: 0, strictPort: false, host: "localhost", watch: { ignored: [ignoreTauriExceptMigrations] } },
      plugins: [devServerSync({
        root,
        migrationsDir: migrations(),
        importers: [join(root, "src", "main.ts")],
        dependencyFiles: [join(root, "package.json"), join(root, "package-lock.json")],
        catalogFile: join(root, "catalog.json"),
      })],
    });
    sent = [];
    const send = server.ws.send.bind(server.ws) as (...args: unknown[]) => void;
    (server.ws as unknown as { send: (...args: unknown[]) => void }).send = (...args: unknown[]) => {
      if (args[0] && typeof args[0] === "object") sent.push(args[0] as { type: string });
      send(...args);
    };
    await server.listen();
    expect(await served()).toEqual(["0001_initial.sql", "0002_second.sql"]);
    // Let the watcher finish its initial scan, so the files written next arrive as events.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, 20_000);

  afterEach(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves a migration added after it started, and reloads the page once", async () => {
    write("0003_category_hierarchy.sql");
    expect(await until(served, (names) => names.includes("0003_category_hierarchy.sql"))).toEqual(["0001_initial.sql", "0002_second.sql", "0003_category_hierarchy.sql"]);
    await until(reloads, (count) => count === 1);
    expect((await status()).migrations).toEqual([1, 2, 3]);
  }, 20_000);

  it("reloads when a migration changes, and serves the new text", async () => {
    const before = await status();
    write("0002_second.sql", "CREATE TABLE changed_text (id INTEGER);");
    await until(reloads, (count) => count >= 1);
    const code = await until(async () => (await fetch(`${base()}/src-tauri/migrations/0002_second.sql?raw`)).text(), (text) => text.includes("changed_text"));
    expect(code).toContain("changed_text");
    const after = await until(status, (current) => !current.stale && current.migrationDigest !== before.migrationDigest);
    expect(after.migrations).toEqual(before.migrations);
  }, 20_000);

  it("reloads a catalog edit even when the version number is unchanged", async () => {
    const before = await status();
    writeFileSync(join(root, "catalog.json"), '{"version":3,"modules":["transactions"]}');
    await until(reloads, (count) => count >= 1);
    const after = await status();
    expect(after.catalog?.version).toBe(3);
    expect(after.catalog?.digest).not.toBe(before.catalog?.digest);
    expect(after.stale).toBe(false);
  }, 20_000);

  it("follows a rename and a removal", async () => {
    renameSync(join(migrations(), "0002_second.sql"), join(migrations(), "0002_renamed.sql"));
    expect(await until(served, (names) => names.includes("0002_renamed.sql") && !names.includes("0002_second.sql"))).toEqual(["0001_initial.sql", "0002_renamed.sql"]);
    await until(reloads, (count) => count >= 1);
    unlinkSync(join(migrations(), "0002_renamed.sql"));
    expect(await until(served, (names) => names.length === 1)).toEqual(["0001_initial.sql"]);
  }, 20_000);

  it("still tells the page the truth when the watcher misses a file (the 2026-11-28 situation)", async () => {
    await server.watcher.unwatch(migrations());
    await new Promise((resolve) => setTimeout(resolve, 200));
    write("0003_category_hierarchy.sql");
    await new Promise((resolve) => setTimeout(resolve, 800));
    // The page's list is stale (no event arrived) …
    expect(await served()).toEqual(["0001_initial.sql", "0002_second.sql"]);
    // … but the status the page compares it with reads the folder itself.
    expect((await status()).migrations).toEqual([1, 2, 3]);
    const { checkServedMigrations } = await import("../src/services/browserDatabase");
    const page = Object.fromEntries((await served()).map((name) => [`../src-tauri/migrations/${name}`, ""]));
    const onDisk = (await status()).migrations;
    expect(() => checkServedMigrations(page, onDisk)).toThrow(/browser preview migrations are out of date/);
  }, 20_000);

  it("refuses stale SQL with an unchanged migration number", async () => {
    const catalog = { version: 3, modules: [] };
    const files = Object.fromEntries(["0001_initial.sql", "0002_second.sql"].map((name) => [name, readFileSync(join(migrations(), name), "utf8")]));
    const { checkPreviewInputs } = await import("../src/services/browserDatabase");
    const before = await status();
    await expect(checkPreviewInputs(files, catalog, { ...before, catalog: before.catalog! })).resolves.toBeUndefined();
    await expect(checkPreviewInputs({ ...files, "0002_second.sql": "SELECT 2;" }, catalog, { ...before, catalog: before.catalog! })).rejects.toThrow(/different migration contents/);
    await expect(checkPreviewInputs(files, { ...catalog, version: 4 }, { ...before, catalog: before.catalog! })).rejects.toThrow(/different module catalogs/);
  }, 20_000);

  it("ignores the rest of src-tauri (no reload for Rust build output)", async () => {
    writeFileSync(join(root, "src-tauri", "target", "build-output.sql"), "SELECT 1;");
    writeFileSync(join(root, "src-tauri", "lib.sql"), "SELECT 1;");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(reloads()).toBe(0);
    expect(await served()).toEqual(["0001_initial.sql", "0002_second.sql"]);
  }, 20_000);

  it("reports itself stale, in its status and in the page, when the dependencies change", async () => {
    expect(await status()).toMatchObject({ stale: false, dependenciesChanged: false, reasons: [] });
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/new":{}}}');
    const stale = await until(status, (current) => current.stale);
    expect(stale.reasons[0]).toMatch(/npm ci/);
    const overlay = await until(() => sent.filter((message) => message.type === "error"), (errors) => errors.length === 1);
    expect(JSON.stringify(overlay[0])).toMatch(/npm ci/);
    // Putting the file back clears it.
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    expect((await until(status, (current) => !current.stale)).reasons).toEqual([]);
  }, 20_000);
});

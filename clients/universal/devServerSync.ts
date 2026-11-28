// Keeps a long-running dev server (`npm run dev`, the browser preview on :1420) in step with the files
// a `git pull` on either Mac can change underneath it.
//
// Why: on 2026-11-28 a dev server started on 2026-11-23 kept serving migrations 0001–0010 after
// 0011_category_hierarchy.sql arrived, so signing in failed with "no such table: categories". The
// config ignored every path under src-tauri, the migrations included, so the import.meta.glob in
// src/services/platform.ts never saw the new file.
//
// - Migrations (add, change, rename, remove): the importer's glob is refreshed and the page is fully
//   reloaded, because the preview builds its in-memory database once per page load.
// - package.json / package-lock.json: new dependencies need `npm ci` and a restart, which a running
//   server cannot do for itself. It says so in the terminal and as an overlay in the page.
// - GET /__billie/dev-status: what this server started from and whether it is stale; read by
//   `ops/dev-services.sh preview status` and after `ops/git-sync.sh pull`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";

export interface DevServerSyncOptions {
  /** The app folder (clients/universal). */
  root: string;
  /** Absolute path of src-tauri/migrations. */
  migrationsDir: string;
  /** Absolute paths of the modules whose import.meta.glob reads the migrations. */
  importers: string[];
  /** Absolute paths whose change needs `npm ci` and a restart. */
  dependencyFiles: string[];
}

export interface DevServerStatus {
  pid: number;
  root: string;
  startedAt: string;
  startedHead: string | null;
  head: string | null;
  migrations: number[];
  dependenciesChanged: boolean;
  stale: boolean;
  reasons: string[];
}

/**
 * Paths the dev server must not watch: everything under src-tauri (Rust sources and multi-gigabyte
 * target folders) except src-tauri/migrations, which the browser preview reads.
 */
export function ignoreTauriExceptMigrations(path: string): boolean {
  return /[\\/]src-tauri[\\/](?!migrations(?:[\\/]|$))/.test(path);
}

export function migrationVersions(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).map((name) => Number(name.slice(0, 4))).sort((a, b) => a - b);
}

function gitHead(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function fingerprint(files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(existsSync(file) ? readFileSync(file) : "(missing)").update("\0");
  return hash.digest("hex");
}

export function devServerSync(options: DevServerSyncOptions): Plugin {
  const migrationsDir = resolve(options.migrationsDir);
  const dependencyFiles = options.dependencyFiles.map((file) => resolve(file));
  const isMigration = (file: string) => {
    const rel = relative(migrationsDir, resolve(file));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && rel.endsWith(".sql");
  };

  return {
    name: "billie-dev-server-sync",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      const startedAt = new Date().toISOString();
      const startedHead = gitHead(options.root);
      const startedDependencies = fingerprint(dependencyFiles);
      const log = server.config.logger;

      const status = (): DevServerStatus => {
        const dependenciesChanged = fingerprint(dependencyFiles) !== startedDependencies;
        const reasons = dependenciesChanged ? ["package.json or package-lock.json changed since this server started: run `npm ci` in clients/universal, then restart it"] : [];
        return { pid: process.pid, root: options.root, startedAt, startedHead, head: gitHead(options.root), migrations: migrationVersions(migrationsDir), dependenciesChanged, stale: reasons.length > 0, reasons };
      };

      // A rename arrives as unlink + add, and a pull may bring several files: reload once.
      let reload: ReturnType<typeof setTimeout> | undefined;
      const changes = new Set<string>();
      const onMigration = (event: string) => (file: string) => {
        if (!isMigration(file)) return;
        for (const importer of options.importers) {
          for (const module of server.moduleGraph.getModulesByFile(resolve(importer)) ?? []) server.moduleGraph.invalidateModule(module);
        }
        changes.add(`${basename(file)} ${event}`);
        clearTimeout(reload);
        reload = setTimeout(() => {
          log.info(`[billie] migration ${[...changes].join(", ")}: reloading the browser preview so it rebuilds its database`, { timestamp: true });
          changes.clear();
          server.ws.send({ type: "full-reload", path: "*" });
        }, 150);
      };

      let warned = false;
      const onDependencies = (file: string) => {
        if (!dependencyFiles.includes(resolve(file))) return;
        const current = status();
        if (!current.dependenciesChanged) { warned = false; return; }
        if (warned) return;
        warned = true;
        const message = `[billie] ${current.reasons[0]} (ops/dev-services.sh preview restart).`;
        log.warn(message, { timestamp: true });
        server.ws.send({ type: "error", err: { message, stack: "", plugin: "billie-dev-server-sync" } });
      };

      server.watcher.add([migrationsDir, ...dependencyFiles]);
      server.watcher.on("add", onMigration("added"));
      server.watcher.on("change", onMigration("changed"));
      server.watcher.on("unlink", onMigration("removed"));
      for (const event of ["add", "change", "unlink"] as const) server.watcher.on(event, onDependencies);
      server.httpServer?.once("close", () => clearTimeout(reload));

      server.middlewares.use("/__billie/dev-status", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(status()));
      });
    },
  };
}

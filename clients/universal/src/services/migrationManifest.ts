/** The preview server and the browser fingerprint exactly the same file names and SQL. */
export function migrationManifest(sources: Record<string, string>): string {
  const entries = Object.entries(sources).map(([path, sql]) => [path.split(/[\\/]/).pop() ?? path, sql]);
  return JSON.stringify(entries.filter(([name]) => /^\d{4}_.+\.sql$/.test(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

# BillieWeather SQL plugin compatibility patch

Source: crates.io `tauri-plugin-sql 2.6.0`, upstream
[`44293a5722efcaf27060504e63b17aeba721b40f`](https://github.com/tauri-apps/plugins-workspace/tree/44293a5722efcaf27060504e63b17aeba721b40f/plugins/sql).
The original licenses and IPC permissions are included.

This copy moves the plugin from SQLx 0.8 to SQLx 0.9 to retain one SQLite engine
and one connection pool per database while shipping patched SQLite. It adapts
the existing IPC query and static migration calls to the new SQLx string API.
The migration SQL, checksums, filenames, storage directory and IPC are the same.
Only the SQLite feature ships in BillieWeather.

Remove the compatibility copy once a stable upstream Tauri 2 plugin supports
a SQLx release that resolves a patched bundled SQLite.

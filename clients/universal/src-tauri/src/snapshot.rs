//! Automatic copy of every local database file before a schema migration runs (review P0-5).
//!
//! The SQL plugin applies pending migrations when the web view first opens a database, which is
//! always after `setup` has finished. So at startup, for every slot file that exists and was last
//! seen at an older schema version, the file (and its -wal / -shm companions, if present) is
//! copied to `<file>.pre-v<N>-<unix seconds>.bak` next to it. The newest two copies per slot are
//! kept. A small sidecar file `<file>.schema` remembers the version the copy was made for, so an
//! unchanged app never copies again.
//!
//! Nothing here opens, reads or parses the database: the copy is byte-for-byte.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many automatic copies are kept per database file.
pub const KEEP: usize = 2;

/// Copies `dir/<file>` when its recorded schema version is older than `version`.
/// Returns the path of the copy, or None when no copy was needed (no file, already current).
pub fn snapshot_if_needed(dir: &Path, file: &str, version: u32) -> io::Result<Option<PathBuf>> {
    let db = dir.join(file);
    if !db.is_file() {
        return Ok(None);
    }
    let sidecar = dir.join(format!("{file}.schema"));
    let recorded: u32 = fs::read_to_string(&sidecar).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(0);
    if recorded >= version {
        return Ok(None);
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let base = format!("{file}.pre-v{version}-{stamp}.bak");
    let copy = dir.join(&base);
    copy_atomically(&db, &copy)?;
    for suffix in ["-wal", "-shm"] {
        let companion = dir.join(format!("{file}{suffix}"));
        if companion.is_file() {
            copy_atomically(&companion, &dir.join(format!("{base}{suffix}")))?;
        }
    }
    prune(dir, file)?;
    fs::write(&sidecar, version.to_string())?;
    Ok(Some(copy))
}

/// Writes to a temporary name first so a crash never leaves a half-written `.bak`.
fn copy_atomically(from: &Path, to: &Path) -> io::Result<()> {
    let partial = to.with_extension("partial");
    fs::copy(from, &partial)?;
    fs::rename(&partial, to)
}

/// Keeps the newest `KEEP` copies of this file (by the timestamp in the name).
fn prune(dir: &Path, file: &str) -> io::Result<()> {
    let prefix = format!("{file}.pre-v");
    let mut copies: Vec<(u64, String)> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(&prefix) && name.ends_with(".bak"))
        .filter_map(|name| {
            let stamp = name.trim_end_matches(".bak").rsplit('-').next()?.parse::<u64>().ok()?;
            Some((stamp, name))
        })
        .collect();
    copies.sort_by(|a, b| b.cmp(a));
    for (_, name) in copies.into_iter().skip(KEEP) {
        let _ = fs::remove_file(dir.join(&name));
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(dir.join(format!("{name}{suffix}")));
        }
    }
    Ok(())
}

/// One automatic copy, as listed to the app (names only, never paths).
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct SnapshotInfo {
    pub name: String,
    pub database: String,
    pub version: u32,
    pub created: u64,
    pub size: u64,
}

/// Every automatic copy of the given database files, newest first.
pub fn list(dir: &Path, databases: &[String]) -> io::Result<Vec<SnapshotInfo>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)?.filter_map(|e| e.ok()) {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if let Some(info) = parse(&name, databases) {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            found.push(SnapshotInfo { size, ..info });
        }
    }
    found.sort_by(|a, b| b.created.cmp(&a.created).then(a.name.cmp(&b.name)));
    Ok(found)
}

fn parse(name: &str, databases: &[String]) -> Option<SnapshotInfo> {
    let rest = name.strip_suffix(".bak")?;
    let database = databases.iter().find(|db| rest.starts_with(&format!("{db}.pre-v")))?;
    let tail = &rest[database.len() + ".pre-v".len()..];
    let (version, created) = tail.split_once('-')?;
    Some(SnapshotInfo { name: name.to_string(), database: database.clone(), version: version.parse().ok()?, created: created.parse().ok()?, size: 0 })
}

/// Copies a listed snapshot (and its -wal) to `target`, which must not exist yet.
pub fn restore(dir: &Path, databases: &[String], snapshot: &str, target: &str) -> io::Result<()> {
    if parse(snapshot, databases).is_none() || !databases.iter().any(|db| db == target) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unknown snapshot or database"));
    }
    let source = dir.join(snapshot);
    let destination = dir.join(target);
    if !source.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "snapshot not found"));
    }
    if destination.exists() || dir.join(format!("{target}-wal")).exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "that database slot is in use"));
    }
    let wal = dir.join(format!("{snapshot}-wal"));
    if wal.is_file() {
        copy_atomically(&wal, &dir.join(format!("{target}-wal")))?;
    }
    copy_atomically(&source, &destination)?;
    // The restored file is at the snapshot's version; let the next start copy it again before migrating.
    let _ = fs::remove_file(dir.join(format!("{target}.schema")));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bw-snapshot-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn backups(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.ends_with(".bak")).collect();
        names.sort();
        names
    }

    #[test]
    fn copies_before_a_new_version_and_never_twice() {
        let dir = temp_dir("once");
        fs::write(dir.join("billieweather.db"), b"synthetic database bytes").unwrap();
        fs::write(dir.join("billieweather.db-wal"), b"wal").unwrap();
        let copy = snapshot_if_needed(&dir, "billieweather.db", 7).unwrap().expect("a copy");
        assert_eq!(fs::read(&copy).unwrap(), b"synthetic database bytes");
        assert!(dir.join(format!("{}-wal", copy.file_name().unwrap().to_str().unwrap())).is_file());
        assert_eq!(fs::read_to_string(dir.join("billieweather.db.schema")).unwrap(), "7");
        assert!(snapshot_if_needed(&dir, "billieweather.db", 7).unwrap().is_none());
        // The original is untouched.
        assert_eq!(fs::read(dir.join("billieweather.db")).unwrap(), b"synthetic database bytes");
    }

    #[test]
    fn lists_and_restores_into_an_empty_slot_only() {
        let dir = temp_dir("restore");
        let dbs = vec!["billieweather.db".to_string(), "billieweather-2.db".to_string()];
        fs::write(dir.join("billieweather.db"), b"v6 data").unwrap();
        let copy = snapshot_if_needed(&dir, "billieweather.db", 7).unwrap().unwrap();
        let name = copy.file_name().unwrap().to_str().unwrap().to_string();
        let listed = list(&dir, &dbs).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].database.as_str(), listed[0].version, listed[0].size), ("billieweather.db", 7, 7));
        // Never over an existing file.
        assert!(restore(&dir, &dbs, &name, "billieweather.db").is_err());
        assert!(restore(&dir, &dbs, "../etc/passwd", "billieweather-2.db").is_err());
        assert!(restore(&dir, &dbs, &name, "../evil.db").is_err());
        restore(&dir, &dbs, &name, "billieweather-2.db").unwrap();
        assert_eq!(fs::read(dir.join("billieweather-2.db")).unwrap(), b"v6 data");
        assert!(restore(&dir, &dbs, &name, "billieweather-2.db").is_err());
    }

    #[test]
    fn missing_files_are_skipped() {
        let dir = temp_dir("missing");
        assert!(snapshot_if_needed(&dir, "billieweather-3.db", 7).unwrap().is_none());
        assert!(!dir.join("billieweather-3.db.schema").exists());
    }

    #[test]
    fn keeps_the_newest_two_copies() {
        let dir = temp_dir("prune");
        fs::write(dir.join("billieweather.db"), b"x").unwrap();
        for (version, stamp) in [(5, 100), (6, 200), (7, 300)] {
            fs::write(dir.join(format!("billieweather.db.pre-v{version}-{stamp}.bak")), b"old").unwrap();
        }
        fs::write(dir.join("billieweather-2.db.pre-v7-50.bak"), b"other slot").unwrap();
        snapshot_if_needed(&dir, "billieweather.db", 8).unwrap().expect("a copy");
        let names = backups(&dir);
        let mine: Vec<&String> = names.iter().filter(|n| n.starts_with("billieweather.db.")).collect();
        assert_eq!(mine.len(), KEEP, "{names:?}");
        assert!(!mine.iter().any(|n| n.contains("-100.bak") || n.contains("-200.bak")));
        assert!(names.contains(&"billieweather-2.db.pre-v7-50.bak".to_string()), "other slots are never pruned");
    }
}

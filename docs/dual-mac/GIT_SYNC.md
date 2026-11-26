> **2026-11-25:** `autonomous-development`, `infra/dual-mac` and the audit branches are consolidated into `main`.
> The branch table below is historical. Clone or pull `main`; see [DEVELOPMENT_QUICKSTART.md](DEVELOPMENT_QUICKSTART.md).

# Git synchronization

GitHub (`heyjyun/BillieWeather`) is the only channel for source between the Macs.
`ops/git-sync.sh` wraps the safe operations.

## State on 2026-11-25 (MacBook)

| Branch | Tip | vs `origin/main` |
| --- | --- | --- |
| `autonomous-development` | 34a2aeb (0.9.0-beta.1 rc2) | +67, never pushed |
| `main` | 77b9036 | +60, never pushed |
| `rollback/session-safe` | dbd85e7 | +3 |
| `phase-1a-modular-shell` | e4380af | = origin/main, **114 uncommitted changes** in `billieweather/` (saved as tag `checkpoint/phase6.3-start/wip-equivalent`) |
| `infra/dual-mac` | this work | new |

Plus untracked Phase 6.3 evidence in `billieweather-roadmap/docs/audits/evidence/2026-11-25-phase6.3/`.
The scan `ops/git-sync.sh check origin/main..autonomous-development` is clean (428 files: no databases,
keys, `.env`, build output or credential-shaped strings, after the two reviewed exceptions in
`ops/git-sync.allow`).

## First-time publication (needs your authorization — nothing has been pushed)

```sh
cd billieweather-roadmap
ops/git-sync.sh check origin/main..autonomous-development
git push origin autonomous-development        # integration branch
git push origin infra/dual-mac                # these scripts and docs
# after the 0.9.0-beta.1 acceptance: fast-forward main and tag
git push origin main
git push origin v0.9.0-beta.1
```

The 114 uncommitted files in `billieweather/` (phase-1a work) are older than `autonomous-development`
and partly superseded by it. Decide whether to commit them to a `wip/phase-1a-shell` branch or drop
them; they are preserved by the checkpoint tag either way.

## Daily flow

| On the Mac mini | On the MacBook |
| --- | --- |
| `git switch -c feature/x autonomous-development` … commit | nothing required |
| `ops/doctor.sh --tests` | |
| `ops/git-sync.sh push feature/x` | |
| merge into `autonomous-development` (fast-forward or PR) | |
| release: fast-forward `main`, `git tag -a vX.Y.Z`, push both | install the release folder |

If you edit on the MacBook occasionally: `ops/git-sync.sh pull` first (fast-forward only), commit on a
branch, `ops/git-sync.sh push <branch>`, then `git pull --ff-only` on the mini.

## Rules

- Never `push --force` to `main` or `autonomous-development`; never rewrite pushed history.
- Never commit: `*.db*`, `*.bak`, `*.dmg`, `.app`, `target/`, `node_modules/`, `.env*` (except
  `.env.example`), `config/master.key`, `config/credentials/*.key`, statements, receipts, exported data.
- `ops/git-sync.sh push` runs the scan and refuses on findings; add a line to `ops/git-sync.allow` only
  after reviewing the exact file or string.
- Agents on the Mac mini commit locally and never push (`ops/agent-run.sh` instructs them so); a person
  pushes after review.
- Local `checkpoint/*` tags and the `.bundle` in `ClaudeGenerated/checkpoint-phase6.3/` stay local.

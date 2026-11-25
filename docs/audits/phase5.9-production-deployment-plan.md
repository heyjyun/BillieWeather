# Phase 5.9: production deployment and rollback plan

Not executed. Render and Neon were not contacted. Generic target preparation and release commands are in the [runbook](render-neon-release-runbook.md); this is the order for this release.

## What changes for people

Everyone signs in once more, in the apps and on the website: older tokens and cookies cannot be revoked individually, so they are not accepted. Local databases are not touched. Apps older than this release are expected to keep working after signing in; that was not tested.

## Order

1. **Before**: approved commit; Render automatic deploys off; Neon branch, roles and `billie.environment` / `billie.target_id` verified; recovery point recorded and one backup restored in an isolated target.
2. **Migrate**: `bin/billie-release rails` (adds `user_sessions`), then `bin/billie-release identity`. Grant the Rails runtime role DML on `user_sessions` and its sequence.
3. **Rails**: deploy. 4. **identity-api**: deploy, `/health` must report ready. 5. Rails with the module sync flag as today; changing it is a separate change.
6. **App**: distribute only after the servers pass.

| If | Then |
| --- | --- |
| Rails is deployed before the migration | Every sign-in and request answers 500 (rehearsed); nothing is written. Migrate, no redeploy needed |
| The migration fails | It is one transaction; the previous release keeps running |
| The runtime role lacks the grant | Expected: sign-in fails closed; grant and retry. Not rehearsed: the isolated cluster has one role |
| Health or smoke test fails | Redeploy the previous release on the new schema (rehearsed) |

## Smoke test, synthetic account

`/up` 200; `/health` ready; register; sign in; `GET finance` 200; sign out 204, the same token then 401; two devices, sign out others, the other gets 401; website sign-in, sign-out, the copied cookie is refused; password change ends every session.

## Rollback

**Superseded on 2026-11-25**: close the rollback fence and roll back to `rollback/session-safe` instead ([runbook](render-neon-release-runbook.md)). Without the fence: redeploy the previous Rails release and keep the schema. **This brings back the old defect**: tokens issued before the release, and tokens that were signed out, are accepted again until they expire (rehearsed: 200). Do not run the down migration unless the table itself is the problem; it deletes the sessions, so everyone signs in again. If accounts may be compromised, change those passwords: both releases honour that.

## Rehearsal, 2026-11-24, isolated PostgreSQL, 20 synthetic transactions

| Step | Pre-release token | New sign-in | Sign-out, then finance |
| --- | --- | --- | --- |
| Previous release | 200 | 201 | not asked |
| New code, no migration | 500 | 500 | 500 |
| Migrated, new code | 401 | 201 | 204, 401 |
| Rolled back to the previous code | 200 | 201 | 204, 200 |
| Forward again | 401 | 201 | 204, 401 |

All 28 financial tables had identical row fingerprints before, after the migration and at the end (three of them hold rows; the others were empty). A `pg_dump` taken before the migration restored identically. Not covered: production size, concurrent traffic, Neon pooling, Render.

## Monitoring for the first day

5xx rate, 401 rate on `/api/client/v1` (a peak is expected once), sign-in failures, growth of `user_sessions`, database connections.

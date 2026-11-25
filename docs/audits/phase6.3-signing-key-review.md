# Removing `SECRET_KEY_BASE` from Render: independent review

2026-11-25. Local rehearsal only ([16 steps](evidence/2026-11-25-phase6.3/signing-key-rehearsal.txt)). Render, Neon and their secrets were not contacted. **Nothing here is approved yet.**

## Verdict

The removal is right and needed, but the runbook's reason was incomplete. Two gaps were found; the code side is fixed (`22ee243`), one check remains yours:

1. **The startup check was silent while the fence was open.** It warned only when both variables held the same value. With the old key still set next to a new one, a rollback accepts signed-out tokens (step 6). It now warns while `SECRET_KEY_BASE` has any value.
2. **Deleting the variable is not always enough.** Rails then reads `secret_key_base` from the encrypted credentials if a master key is available. With the old value there, the old release boots and accepts signed-out tokens (step 9). The check now warns about this too.

**Check before deleting, in Render:** is `RAILS_MASTER_KEY` set? If so, does `bin/rails credentials:show` list a `secret_key_base`? It must not hold the current key. I did not look at any real credentials.

## Why removal is required

Releases before `user_sessions` sign app tokens with the key and keep no record of them, so they cannot refuse a signed-out token. Whoever can make such a release run with the old key brings every unexpired old token (30 days) and cookie back.

## What depends on the key

| Uses it | Effect of a new key |
| --- | --- |
| Old app tokens (signed) | refused, also by the old release |
| Website cookies: session, remember-me, flash, CSRF | website signed out once |
| Password-reset and confirmation links (Devise digests) | outstanding links stop working; request a new one |
| Typed-command plans, undo tokens, tenant ids (HMAC) | unfinished plans and command undo are lost |
| Signed ids (Active Storage, Turbo streams, global ids) | links in open pages stop working until reload |

| Does not use it | |
| --- | --- |
| App sessions of the new release | random, only a digest in `user_sessions`: **survive any key change** (steps 13, 15) |
| Passwords (bcrypt, no pepper), two-factor secrets (Active Record encryption keys), OAuth/API tokens, capture tokens, financial data, uploaded files | unchanged |
| identity-api | reads no Rails key |
| Asset build | uses a dummy key |

## Token revocation

Independent of the key: sign-out, password change and "sign out other devices" end rows in `user_sessions`. Therefore **a key change does not sign anyone out of the apps**. If a key leaked: change it *and* end the sessions, with `UserSession.active.update_all(revoked_at: Time.current, revoke_reason: "signed_out_elsewhere", updated_at: Time.current)`.

## Key management

- Generate: Render `generateValue` in the group `settings`, or `openssl rand -hex 64` entered directly in Render. Never in Git, a shell history, a ticket or a chat.
- One value per environment; never reuse the old one (step 16: works, but the fence is open and now warned about).
- Keep it only in Render and the password manager of two owners. Rotate after a leak or when someone with access leaves; not on a schedule, since it only costs sign-ins.
- **Do not set `SECRET_KEY_BASE` to a random value instead of deleting it.** It is as safe against tokens (step 10), but an old release would run and issue new unrevocable tokens. A release that refuses to boot (step 8) is the better failure.

## Deployment order

1. Confirm the check above; automatic deploys off; recovery point noted.
2. Migrate (`20261125000100` is additive; the old release runs on it, step 3).
3. Add `BILLIE_SECRET_KEY_BASE`. Keep `SECRET_KEY_BASE`: if the deploy fails now, the old release must still run.
4. Deploy the new release. Everyone signs in once. The log shows "rollback fence open": expected here.
5. Smoke test: sign in, sign out, old token refused, website, reset mail.
6. Decide there is no way back to the old release. **Then** delete `SECRET_KEY_BASE` from the service and from the group. Expect the service to restart.
7. The warning must be gone from the log. Repeat the smoke test.

Between 4 and 6 a rollback is possible and insecure (step 6): keep it to minutes.

## Rollback and recovery

| Situation | Do |
| --- | --- |
| Deploy fails before step 6 | roll back to the old release; signed-out tokens work again until the new release is back |
| After step 6, new release broken | deploy `rollback/session-safe` (`dbd85e7`): keeps every session and revocation (step 11). It needs `BILLIE_SECRET_KEY_BASE` |
| Old release started by accident after step 6 | refuses to boot (step 8), no data touched |
| `BILLIE_SECRET_KEY_BASE` lost, both missing | does not boot (step 14): set a fresh value; apps stay signed in, website signs in again (step 15) |
| `BILLIE_SECRET_KEY_BASE` lost but `SECRET_KEY_BASE` still set | boots with the old key and warns (step 13) |
| Key leaked | fresh value, deploy, end all sessions (above) |
| Old value wanted back | never; it revives every old token |

## Still needed from you

Authorization for each of: adding the variable, deploying, deleting the variable. And the master-key check.

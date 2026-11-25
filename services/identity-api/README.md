# BillieWeather Identity API

A standalone FastAPI service that lets the BillieWeather apps (macOS, Windows, iOS, Android: the
shared React client in `clients/universal`) create accounts **in the app**, without opening the
Rails website. It writes Devise-compatible accounts into the existing database, so every account,
wherever it was created, signs in through the existing Rails endpoint (`POST /api/client/v1/session`).

It does not import Ruby, start Rails, or proxy to Rails. Scope: registration, email verification,
Google sign-up and linking. Sign-in, sessions, password reset and everything else stay in Rails.

## Architecture

```
Universal Client (React/Tauri) ──► identity-api (FastAPI)  ──► Neon Postgres: public.users / teams / memberships (insert only)
        │                               │                                      identity.* (its own schema)
        │                               └──► Postmark (code email), Google OAuth, HIBP range API
        └────────────────────────────────► Rails /api/client/v1/session (sign-in, unchanged)
Local SQLite (financial data) never leaves the device during registration.
```

| Module | Responsibility |
| --- | --- |
| `config.py` | Environment settings; production refuses unsafe values |
| `schema.py` + `migrations/` | Additive `identity` schema migrations; Rails schema compatibility check |
| `accounts.py` | The only code that touches Rails tables: account creation (user + team + admin membership), Google linking, failed-attempt counting |
| `registration.py` | Email/password sign-up, emailed code, resend |
| `google.py` | Google OAuth (code + PKCE + nonce), ID-token verification, app polling, linking |
| `passwords.py` | Devise-compatible bcrypt, Have I Been Pwned check |
| `tokens.py` | Secrets, codes, HMAC digests, PKCE helpers |
| `mailer.py` | Postmark / outbox / memory delivery, localized copy (6 languages) |
| `ratelimit.py`, `logs.py`, `main.py` | Limits, redacting logs, HTTP layer |

## Compatibility with existing accounts (verified)

What the Rails sign-up does, and what this service reproduces in **one transaction**:

| Rails / Devise behavior | Here |
| --- | --- |
| `database_authenticatable`: `BCrypt::Password.create(pw, cost: 11)`, no pepper, `$2a$` | `bcrypt` with `prefix=2a`, cost 11, explicit 72-byte truncation (same as Ruby's bcrypt) |
| `validatable`: email stripped + downcased, `/\A[^@\s]+@[^@\s]+\z/` (ASCII `\s`), unique; password 6..128 | Same rules (emails also limited to 254 chars, no control chars: stricter, never looser) |
| `pwned_password` (on outside development): reject if seen ≥1 time; fail open | Same, k-anonymity range API |
| `User`: nickname squished, required (≥ 1 visible character, no control characters) ≤ 40; `usage_region` required, in `UsageRegion::CODES` (incl. `XG` Global Citizen) | Same; region list tested against `app/models/usage_region.rb` and the DB check constraint |
| `create_default_team`: team "Your Team", membership `role_ids ["admin"]` + `user_email`, `current_team_id` | Same rows; `ability_cache = {}`; timestamps UTC without zone |
| `finance_owner_uid` | Left to the database default `gen_random_uuid()` |
| `lockable` (20 attempts) | Google linking counts failures in `users.failed_attempts`; refuses at the limit (Rails then locks and emails the unlock link) |
| `GoogleSignIn` rules | Same: verified email only, `sub` is the identity, linking needs the password, refused for 2FA / locked / differently linked / agent accounts |

Verified by `tests/test_compat.py` (with `IDENTITY_RAILS_COMPAT=1`): accounts created here are
loaded by the real Rails app, which confirms `valid?`, `valid_password?`, `active_for_authentication?`,
one team, admin membership, `needs_usage_region? == false`, and **an actual `POST /api/client/v1/session`
returning 201 with a token that authenticates**. Rails-created accounts are recognized as duplicates,
and their Devise passwords link Google.

**Not reproduced**
- The optional welcome email (`UserMailer.welcome`): the verification email replaces it.
- `real_emails_only` (only active when `REALEMAIL_API_KEY` is set; not set in this app's config).
- Invitations (`invitation_uuid`): in-app sign-up never joins another team; invitations stay on the website.

## Email verification design

Rails has no `:confirmable`, so a `users` row can sign in as soon as it exists. Therefore the
Rails row is created **only after** the emailed code is confirmed. Until then the sign-up lives in
`identity.pending_registrations`.

- Confirming needs the 8-digit code **and** a registration secret that only the registering app
  holds. Someone who starts a sign-up for another person's address cannot get it confirmed by that
  person (no clickable link exists), so they cannot plant their own password on someone else's email.
- Code: 30 minutes; 5 wrong tries per registration, 20 per address per day; registration: 24 hours.
- Resend: 60 s apart, 5 emails in total. Per-IP and per-address windows on top.
- No enumeration: an address that already has an account gets the same 202 response; the owner
  receives a "you already have an account" email instead of a code.
- Only HMAC-SHA256 digests of secrets and codes are stored; the password hash is erased when the
  registration ends; `purge()` deletes old rows.

### Temporary bypass: `EMAIL_VERIFICATION_REQUIRED`

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMAIL_VERIFICATION_REQUIRED` | `true` | `false` = eligible sign-ups get the account at once (`201 {status: created, email_verified: false}`), no email, no pending registration |
| `EMAIL_VERIFICATION_BYPASS_EMAILS` | empty | With `false`: only these addresses (`@domain` = whole domain) skip verification, in every environment. Empty = every address in development/test; **production refuses to start** |
| `DEVELOPER_EMAILS` | empty | Never eligible (Rails grants these addresses admin), always verified by email |

- Authenticated account ≠ verified address: `identity.email_verifications` records `unverified` for
  bypass accounts; `verified` only after the emailed code (`email_code`) or Google `email_verified`
  (`google`, including linking, which also needs the account password). Nothing marks an address verified otherwise.
- Ownership-sensitive actions stay proof-based: password reset and unlock are emailed links (Rails),
  Google linking needs the password, and a taken address is refused (`409 email_taken`).
- The code flow (`202`, confirm, resend) is unchanged and returns for everyone when the flag is `true`.
  A pending code sign-up for an address that the bypass then creates is marked `superseded` (`410` on confirm).
- `GET /v1/config` reports `email_verification: required | allowlist | disabled` (never the list). The app
  decides its next screen from the register response only.

## Google design

The app generates a verifier, sends only its S256 challenge, and opens Google in the **system
browser** (no WebView). This service is the OAuth client: authorization code + its own PKCE + state +
nonce, redirect URI `{PUBLIC_URL}/v1/google/callback`; the ID token is verified (RS256 JWKS, `iss`,
`aud`, `exp`, `nonce`, `email_verified`). The app polls `/status` with its verifier; nothing travels
through a deep link (the browser page only offers `billieweather://open`, which carries no data).

### Compatibility blocker (reported, not worked around)

App session tokens are issued, checked and revoked only by Rails (`ClientApi::SessionToken`, rows in
`user_sessions`). This service accepts no session token on any endpoint and has no need for access to that
table. Minting tokens here would put a second writer on the sign-in state. Instead, a Google sign-up in the app also sets a **BillieWeather password**,
and the app signs in with the existing email/password endpoint. Linking an existing account uses
that account's password, then signs in the same way. Google keeps working on the website.

Smallest safe follow-up for a passwordless "Sign in with Google" in the apps: a Rails endpoint
`POST /api/client/v1/session/google` that accepts a short-lived, single-use assertion signed by this
service (asymmetric key; Rails holds only the public key) and issues the normal session token.

## API (v1)

| Method & path | Body | Success |
| --- | --- | --- |
| `GET /v1/config` | – | `registration_open`, `google_available`, password limits |
| `POST /v1/registrations` | `email, password, password_confirmation, usage_region, nickname, locale?` | 202 `registration_id, registration_secret, code_expires_at, resend_available_at`; with the bypass: 201 `status: created, email, nickname, email_verified: false` |
| `POST /v1/registrations/{id}/confirmation` | `registration_secret, code` | 201 `{status: confirmed, email}` (idempotent) |
| `POST /v1/registrations/{id}/resend` | `registration_secret` | 202 |
| `POST /v1/google/flows` | `code_challenge, code_challenge_method: S256, locale?` | 201 `flow_id, authorization_url` |
| `GET /v1/google/callback` | (from Google) | HTML page |
| `POST /v1/google/flows/{id}/status` | `code_verifier` | `status, outcome?, email?, failure?` |
| `POST /v1/google/flows/{id}/complete` | `code_verifier, password, password_confirmation, usage_region, nickname` | 201 |
| `POST /v1/google/flows/{id}/link` | `code_verifier, password` | 200 |
| `POST /v1/google/flows/{id}/cancel` | `code_verifier` | 204 |
| `GET /health` | – | 200 when the DB, Rails schema and identity schema are ready |

Errors are `{"error": code, "fields"?: {field: [code]}, ...}`; submitted values are never echoed.

## Database changes

Only additive, in a separate schema (Rails' schema dumper ignores it, so `db/schema.rb` is unchanged):
`identity.schema_migrations`, `identity.pending_registrations`, `identity.oauth_flows`, `identity.email_verifications`.
No Rails table is altered. The service only INSERTs users/teams/memberships and UPDATEs
`users.current_team_id`, `users.google_uid`, `users.failed_attempts` (linking).

Recommended production role (least privilege):

```sql
CREATE ROLE identity_api LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO identity_api;
GRANT SELECT, INSERT ON public.users, public.teams, public.memberships TO identity_api;
GRANT UPDATE (current_team_id, google_uid, failed_attempts, updated_at) ON public.users TO identity_api;
GRANT USAGE ON SEQUENCE public.users_id_seq, public.teams_id_seq, public.memberships_id_seq TO identity_api;
GRANT CREATE ON DATABASE <db> TO identity_api;  -- once, for CREATE SCHEMA identity (or create it as owner)
```

### Delivery guarantees

- Sending is **synchronous**: `POST /v1/registrations` and `/resend` return 202 only after Postmark
  answered `ErrorCode: 0` with a `MessageID` (logged as `mail_accepted message_id=...`). That is
  Postmark accepting the message, not the inbox receiving it; check Postmark › Activity for the
  final status.
- Network errors, 429 and 5xx are retried (3 attempts, short backoff), then `503 mail_unavailable`.
- Permanent recipient rejections (Postmark 300 invalid address, 406 inactive/bounced/suppressed)
  are not retried: `422 mail_rejected`. Bad token / unverified sender (401, 422 other codes) fail
  without retry as `503 mail_unavailable` and are logged with the Postmark error code.
- A failed first send marks the pending registration `failed`; no usable sign-up is left behind.
- Message bodies, codes and the token are never logged.

## Local development

```bash
cd services/identity-api
uv sync
# A LOCAL database with the Rails schema (never Neon):
createdb billieweather_identity_development
(cd ../.. && RAILS_ENV=development DATABASE_URL=postgres://localhost/billieweather_identity_development bin/rails db:schema:load)
export DATABASE_URL=postgresql://localhost/billieweather_identity_development
uv run python -m identity_api.schema migrate
uv run uvicorn identity_api.main:app --port 8100 --no-access-log
# Codes are written to tmp/outbox/*.json (MAIL_DELIVERY=outbox). NOTHING is emailed; the log line
# mail_not_sent_written_to_outbox shows the file, and the app shows a "not emailed" notice.
```

Email modes (`MAIL_DELIVERY`): `outbox` (default; JSON files), `memory` (tests), `postmark`
(real email for end-to-end testing; refuses to start without `POSTMARK_API_TOKEN` and `MAIL_FROM`).

Client: `VITE_BILLIE_IDENTITY_URL=http://localhost:8100 npm run dev` in `clients/universal`
(desktop builds: `BILLIE_IDENTITY_URL=... npm run desktop:build`, which adds the origin to the CSP).

## Tests

```bash
IDENTITY_TEST_DATABASE_URL=postgresql://localhost/billieweather_identity_test uv run pytest   # required: no default database; creates it (subset schema)
createdb billieweather_identity_compat
(cd ../.. && RAILS_ENV=test DATABASE_URL=postgres://localhost/billieweather_identity_compat bin/rails db:schema:load)
IDENTITY_TEST_DATABASE_URL=postgresql://localhost/billieweather_identity_compat IDENTITY_RAILS_COMPAT=1 uv run pytest   # + real Rails cross-check
```
The harness refuses any database that is not local and named `*_test` / `*_compat`.

## Deployment (Render, manual)

1. Verify the target and apply the approved schema release using the [database release runbook](../../docs/audits/render-neon-release-runbook.md).
2. Configure the separate Render Blueprint at `services/identity-api/render.yaml` with automatic deploys off. Startup checks schema readiness and serves `/health`.
3. Set the verified pooled runtime `DATABASE_URL`, `PUBLIC_URL`,
   `POSTMARK_API_TOKEN`, `MAIL_FROM`, optional `GOOGLE_CLIENT_ID/SECRET` (add the redirect URI
   `{PUBLIC_URL}/v1/google/callback` to the Google client).
4. Build the apps with `BILLIE_IDENTITY_URL=https://<service>.onrender.com` (and `BILLIE_API_URL`).
5. If the website uses `INVITATION_KEYS`, set `REGISTRATION_ENABLED=false`.

### Postmark setup (required before anyone can register)

1. Postmark › Servers › create a server (e.g. "BillieWeather"); copy its **Server API token**
   (not the Account token) into `POSTMARK_API_TOKEN` here and on the Rails `web` service.
2. Postmark › Sender Signatures › add your domain (e.g. `billieweather.app`). Add the DNS records
   it shows at your DNS host: the **DKIM** TXT record and the **Return-Path** CNAME
   (`pm-bounces.<domain>` → `pm.mtasv.net`). Wait until both show "Verified".
3. SPF: Postmark's Return-Path makes SPF align automatically; no `include:` is needed in your root SPF.
   DMARC: add `_dmarc.<domain>` TXT `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` (tighten later).
4. Set `MAIL_FROM` to an address on that verified domain, e.g. `BillieWeather <no-reply@billieweather.app>`.
   A free-mail sender (gmail.com, 163.com, ...) cannot be verified with DKIM and will be refused.
5. A new Postmark account is in **test approval mode**: it only delivers to addresses on your own
   verified domain until you request approval (Account › "Request approval"). Until then, sign-ups
   with other addresses fail with `mail_unavailable` (Postmark error 412).
6. Check: `curl https://<service>.onrender.com/health` is `ok`, register once, then look for
   `mail_accepted message_id=...` in the Render log and the same message in Postmark › Activity.

### Scaling

The per-IP/per-address windows are in-process. Per-registration limits are in the database and
hold across instances. Before running more than one instance, move the windows to a shared store
(e.g. the existing Render Key Value/Redis).

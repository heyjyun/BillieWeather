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
| `User`: nickname squished ≤ 40; `usage_region` required, in `UsageRegion::CODES` (incl. `XG` Global Citizen) | Same; region list tested against `app/models/usage_region.rb` and the DB check constraint |
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

## Google design

The app generates a verifier, sends only its S256 challenge, and opens Google in the **system
browser** (no WebView). This service is the OAuth client: authorization code + its own PKCE + state +
nonce, redirect URI `{PUBLIC_URL}/v1/google/callback`; the ID token is verified (RS256 JWKS, `iss`,
`aud`, `exp`, `nonce`, `email_verified`). The app polls `/status` with its verifier; nothing travels
through a deep link (the browser page only offers `billieweather://open`, which carries no data).

### Compatibility blocker (reported, not worked around)

App session tokens are issued only by Rails (`ClientApi::SessionToken`, signed with Rails'
`secret_key_base`). Minting them here would mean sharing the Rails master secret and coupling to
Rails' message format. Instead, a Google sign-up in the app also sets a **BillieWeather password**,
and the app signs in with the existing email/password endpoint. Linking an existing account uses
that account's password, then signs in the same way. Google keeps working on the website.

Smallest safe follow-up for a passwordless "Sign in with Google" in the apps: a Rails endpoint
`POST /api/client/v1/session/google` that accepts a short-lived, single-use assertion signed by this
service (asymmetric key; Rails holds only the public key) and issues the normal session token.

## API (v1)

| Method & path | Body | Success |
| --- | --- | --- |
| `GET /v1/config` | – | `registration_open`, `google_available`, password limits |
| `POST /v1/registrations` | `email, password, password_confirmation, usage_region, nickname?, locale?` | 202 `registration_id, registration_secret, code_expires_at, resend_available_at` |
| `POST /v1/registrations/{id}/confirmation` | `registration_secret, code` | 201 `{status: confirmed, email}` (idempotent) |
| `POST /v1/registrations/{id}/resend` | `registration_secret` | 202 |
| `POST /v1/google/flows` | `code_challenge, code_challenge_method: S256, locale?` | 201 `flow_id, authorization_url` |
| `GET /v1/google/callback` | (from Google) | HTML page |
| `POST /v1/google/flows/{id}/status` | `code_verifier` | `status, outcome?, email?, failure?` |
| `POST /v1/google/flows/{id}/complete` | `code_verifier, password, password_confirmation, usage_region, nickname?` | 201 |
| `POST /v1/google/flows/{id}/link` | `code_verifier, password` | 200 |
| `POST /v1/google/flows/{id}/cancel` | `code_verifier` | 204 |
| `GET /health` | – | 200 when the DB, Rails schema and identity schema are ready |

Errors are `{"error": code, "fields"?: {field: [code]}, ...}`; submitted values are never echoed.

## Database changes

Only additive, in a separate schema (Rails' schema dumper ignores it, so `db/schema.rb` is unchanged):
`identity.schema_migrations`, `identity.pending_registrations`, `identity.oauth_flows`.
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

## Local development

```bash
cd services/identity-api
uv sync
# A LOCAL database with the Rails schema (never Neon):
createdb billieweather_identity_compat
(cd ../.. && RAILS_ENV=test DATABASE_URL=postgres://localhost/billieweather_identity_compat bin/rails db:schema:load)
export DATABASE_URL=postgresql://localhost/billieweather_identity_compat
uv run python -m identity_api.schema migrate
uv run uvicorn identity_api.main:app --port 8100 --no-access-log
# Codes are written to tmp/outbox/*.json (MAIL_DELIVERY=outbox).
```

Client: `VITE_BILLIE_IDENTITY_URL=http://localhost:8100 npm run dev` in `clients/universal`
(desktop builds: `BILLIE_IDENTITY_URL=... npm run desktop:build`, which adds the origin to the CSP).

## Tests

```bash
uv run pytest                                   # creates billieweather_identity_test (subset schema)
IDENTITY_TEST_DATABASE_URL=postgresql://localhost/billieweather_identity_compat IDENTITY_RAILS_COMPAT=1 uv run pytest   # + real Rails cross-check
```
The harness refuses any database that is not local and named `*_test` / `*_compat`.

## Deployment (Render, manual)

1. Neon: create a branch first and run `python -m identity_api.schema check` against it.
2. Render: New › Blueprint › `services/identity-api/render.yaml` (separate from the Rails blueprint; `autoDeploy: false`).
3. Set `DATABASE_URL` (Neon; the pooled URL works, prepared statements are disabled), `PUBLIC_URL`,
   `POSTMARK_API_TOKEN`, `MAIL_FROM`, optional `GOOGLE_CLIENT_ID/SECRET` (add the redirect URI
   `{PUBLIC_URL}/v1/google/callback` to the Google client).
4. Build the apps with `BILLIE_IDENTITY_URL=https://<service>.onrender.com` (and `BILLIE_API_URL`).
5. If the website uses `INVITATION_KEYS`, set `REGISTRATION_ENABLED=false`.

### Scaling

The per-IP/per-address windows are in-process. Per-registration limits are in the database and
hold across instances. Before running more than one instance, move the windows to a shared store
(e.g. the existing Render Key Value/Redis).

-- Additive only. Creates the `identity` schema used by this service; it never alters or drops
-- anything in the Rails-owned `public` schema. Rails' schema dumper only dumps `public`, so
-- these tables do not appear in db/schema.rb.
CREATE SCHEMA IF NOT EXISTS identity;

-- An email/password sign-up waiting for its emailed code. The Rails `users` row is created
-- only after the code is confirmed, so an unconfirmed address can never sign in.
CREATE TABLE IF NOT EXISTS identity.pending_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(254) NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  -- Devise-compatible bcrypt hash; cleared once the registration is finished.
  encrypted_password varchar(255) NOT NULL DEFAULT '',
  nickname varchar(40),
  usage_region varchar(2) NOT NULL,
  locale varchar(10),
  -- The address already has an account: a notice is mailed instead of a code (no enumeration).
  existing_account boolean NOT NULL DEFAULT false,
  secret_digest char(64) NOT NULL,
  code_digest char(64) NOT NULL,
  code_expires_at timestamptz NOT NULL,
  code_attempts integer NOT NULL DEFAULT 0 CHECK (code_attempts >= 0),
  send_count integer NOT NULL DEFAULT 1 CHECK (send_count >= 1),
  last_sent_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'failed', 'superseded')),
  user_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_registrations_email ON identity.pending_registrations (email, created_at);
CREATE INDEX IF NOT EXISTS pending_registrations_expires ON identity.pending_registrations (expires_at);

-- A Google sign-up started in the app. The app holds a PKCE-style verifier; only it can read
-- the result or finish the sign-up. Google tokens are never stored.
CREATE TABLE IF NOT EXISTS identity.oauth_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(16) NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  state_digest char(64) NOT NULL UNIQUE,
  nonce varchar(64) NOT NULL,
  provider_verifier varchar(128) NOT NULL DEFAULT '',
  client_challenge varchar(64) NOT NULL,
  locale varchar(10),
  status varchar(16) NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'verified', 'cancelled', 'failed', 'completed')),
  outcome varchar(24) CHECK (outcome IS NULL OR outcome IN ('new_account', 'link_required', 'already_linked', 'unavailable')),
  failure varchar(40),
  provider_uid varchar(255),
  email varchar(254),
  user_id integer,
  link_attempts integer NOT NULL DEFAULT 0 CHECK (link_attempts >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_flows_expires ON identity.oauth_flows (expires_at);

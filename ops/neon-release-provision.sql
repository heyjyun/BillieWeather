-- Run as the nominated database owner on the verified direct PostgreSQL endpoint.
-- Required psql variables: target_database, target_owner, target_environment, target_id, phase.
-- Use phase=marker before applying migrations. Use phase=roles after both migration sets.
-- For phase=roles inject BILLIE_RAILS_RUNTIME_PASSWORD and BILLIE_IDENTITY_RUNTIME_PASSWORD.
-- Do not run with psql echo/debug options. Use the separately approved release procedure.
\set ON_ERROR_STOP on

BEGIN;
SELECT current_database() = :'target_database' AND current_user = :'target_owner'
       AND :'target_environment' IN ('local', 'staging', 'production')
       AND :'target_id' ~ '^[A-Za-z0-9_-]{12,128}$'
       AND :'phase' IN ('marker', 'roles') AS valid_target,
       :'phase' = 'roles' AS provision_roles
\gset
\if :valid_target
\else
  SELECT 1 / 0 AS refused_release_target;
\endif

CREATE SCHEMA IF NOT EXISTS billie_release;
REVOKE ALL ON SCHEMA billie_release FROM PUBLIC;
CREATE TABLE IF NOT EXISTS billie_release.target (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
  target_id text NOT NULL CHECK (target_id ~ '^[a-zA-Z0-9_-]{12,128}$')
);
INSERT INTO billie_release.target (environment, target_id) VALUES (:'target_environment', :'target_id')
ON CONFLICT (singleton) DO NOTHING;
SELECT EXISTS (
  SELECT 1 FROM billie_release.target
  WHERE singleton AND environment=:'target_environment' AND target_id=:'target_id'
) AS matches_marker
\gset
\if :matches_marker
\else
  SELECT 1 / 0 AS refused_release_marker;
\endif
REVOKE ALL ON billie_release.target FROM PUBLIC;

\if :provision_roles
  \getenv rails_password BILLIE_RAILS_RUNTIME_PASSWORD
  \getenv identity_password BILLIE_IDENTITY_RUNTIME_PASSWORD
  SELECT length(:'rails_password') >= 32 AND length(:'identity_password') >= 32
         AND :'identity_password' <> :'rails_password' AS valid_credentials
  \gset
  \if :valid_credentials
  \else
    SELECT 1 / 0 AS refused_runtime_credentials;
  \endif

  -- Create roles through PostgreSQL instead of the provider's privileged role API.
  -- Existing roles cause a transaction failure instead of silently rotating their credentials.
  CREATE ROLE billie_rails_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD :'rails_password';
  CREATE ROLE billie_identity_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD :'identity_password';
  REVOKE CREATE ON DATABASE :"target_database" FROM PUBLIC;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON SCHEMA identity FROM PUBLIC;
  GRANT CONNECT ON DATABASE :"target_database" TO billie_rails_runtime, billie_identity_runtime;
  GRANT USAGE ON SCHEMA public, billie_release TO billie_rails_runtime, billie_identity_runtime;
  GRANT SELECT ON billie_release.target TO billie_rails_runtime, billie_identity_runtime;

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO billie_rails_runtime;
  REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations, public.ar_internal_metadata FROM billie_rails_runtime;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO billie_rails_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billie_rails_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO billie_rails_runtime;

  GRANT USAGE ON SCHEMA identity TO billie_identity_runtime;
  GRANT SELECT ON identity.schema_migrations TO billie_identity_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON identity.pending_registrations, identity.oauth_flows,
    identity.email_verifications TO billie_identity_runtime;
  GRANT SELECT, INSERT ON public.users, public.teams, public.memberships TO billie_identity_runtime;
  GRANT UPDATE (current_team_id, failed_attempts, google_uid, updated_at) ON public.users TO billie_identity_runtime;
  GRANT USAGE ON SEQUENCE public.users_id_seq, public.teams_id_seq, public.memberships_id_seq TO billie_identity_runtime;
  -- Raise and roll back if either role can replace the identity marker.
  SELECT NOT bool_or(has_table_privilege(role, 'billie_release.target', 'INSERT,UPDATE,DELETE,TRUNCATE'))
    AS marker_is_protected
  FROM (VALUES ('billie_rails_runtime'), ('billie_identity_runtime')) AS roles(role)
  \gset
  \if :marker_is_protected
  \else
    SELECT 1 / 0 AS refused_marker_permissions;
  \endif
\endif
COMMIT;

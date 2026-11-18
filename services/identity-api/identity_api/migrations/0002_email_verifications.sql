-- Additive only. Records whether the email address of an account created by this service has
-- been PROVEN to belong to its owner, separately from the account itself.
--
-- Rails has no :confirmable, so a users row can sign in as soon as it exists ("authenticated
-- account"). Whether its address is verified is a different fact, stored here:
--   verified   + method email_code : the emailed 8-digit code was confirmed
--   verified   + method google     : Google asserted email_verified for this exact address
--   unverified                     : created while EMAIL_VERIFICATION_REQUIRED=false (testing
--                                    bypass); ownership of the address was never proven
-- An unverified row is never upgraded without one of the proofs above.
CREATE TABLE IF NOT EXISTS identity.email_verifications (
  user_id integer PRIMARY KEY,
  email varchar(254) NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  status varchar(16) NOT NULL CHECK (status IN ('verified', 'unverified')),
  method varchar(16) CHECK (method IS NULL OR method IN ('email_code', 'google')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'verified') = (method IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS email_verifications_unverified ON identity.email_verifications (email) WHERE status = 'unverified';

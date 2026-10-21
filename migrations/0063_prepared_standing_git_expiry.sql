-- An authenticated provider expiry and a confirmed revocation are distinct outcomes.
-- Existing custody, including an uncertain issuance or retirement, is unchanged.
ALTER TABLE occ.prepared_github_attempts
  DROP CONSTRAINT prepared_github_attempts_custody_check,
  ADD CONSTRAINT prepared_github_attempts_custody_check CHECK
    (custody IN ('intent', 'current', 'retire', 'revoking', 'revoked', 'expired', 'unknown')),
  ADD CONSTRAINT prepared_github_attempts_expired_check CHECK
    (custody <> 'expired' OR (state = 'committed' AND material_version IS NOT NULL
      AND isfinite(usable_until) AND isfinite(provider_expires_at)
      AND usable_until < provider_expires_at) IS TRUE);

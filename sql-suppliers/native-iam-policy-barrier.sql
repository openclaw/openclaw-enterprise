-- Unregistered State-owned supplier for CI and tests only. It is not a
-- migration and has no production caller; do not apply it to a deployed
-- database. Until it is registered as a migration, installing it adds an
-- object to the occ schema, so the catalog digest checked by
-- scripts/migration-history.mjs no longer matches and migrations refuse to run
-- until the function is dropped again.
BEGIN;

DO $$
BEGIN
  IF current_user <> 'occ_migrator' THEN
    RAISE EXCEPTION 'native IAM barrier requires the migration owner'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION occ.native_iam_policy_barrier(installation_id text, writing boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  authority_key bigint;
  authority_held boolean;
  previous_lock_timeout text;
BEGIN
  IF installation_id IS NULL OR installation_id = '' OR writing IS NULL THEN
    RAISE EXCEPTION 'invalid native IAM barrier request' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'native IAM barrier requires READ COMMITTED' USING ERRCODE = '25000';
  END IF;

  -- pg_settings reports milliseconds; zero means unbounded. Keep this setting
  -- change inside the guard statement so other work on the client cannot see
  -- it. This caps each lock wait, not the complete barrier or transaction.
  SELECT setting INTO STRICT previous_lock_timeout
  FROM pg_catalog.pg_settings WHERE name = 'lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',
    CASE WHEN previous_lock_timeout::integer = 0 THEN '5000'
         ELSE LEAST(previous_lock_timeout::integer, 5000)::text END, true);

  authority_key := pg_catalog.hashtextextended('native-account-security-v1:' || installation_id, 0);
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_catalog.pg_backend_pid()
      AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
      AND classid = ((authority_key >> 32) & 4294967295)::pg_catalog.oid
      AND objid = (authority_key & 4294967295)::pg_catalog.oid
      AND objsubid = 1
      AND granted
      AND (mode = 'ExclusiveLock' OR (NOT writing AND mode = 'ShareLock'))
  ) INTO authority_held;
  IF NOT authority_held THEN
    RAISE EXCEPTION 'native IAM authority is not held' USING ERRCODE = '55000';
  END IF;

  -- pg_locks does not distinguish a session lock from a transaction lock.
  -- After verifying the preheld mode, retain the same lock for this transaction
  -- without waiting or upgrading a shared read lock.
  IF writing THEN
    IF NOT pg_catalog.pg_try_advisory_xact_lock(authority_key) THEN
      RAISE EXCEPTION 'native IAM authority cannot be retained' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(authority_key) THEN
      RAISE EXCEPTION 'native IAM authority cannot be retained' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM occ.installation WHERE id = installation_id) THEN
    RAISE EXCEPTION 'native IAM authority belongs to another Installation'
      USING ERRCODE = '23514';
  END IF;

  IF writing THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype = 'relation' AND pid = pg_catalog.pg_backend_pid() AND granted
        AND relation IN (
          'occ.iam_identities'::pg_catalog.regclass, 'occ.iam_roles'::pg_catalog.regclass,
          'occ.iam_groups'::pg_catalog.regclass, 'occ.iam_group_memberships'::pg_catalog.regclass,
          'occ.iam_access_bindings'::pg_catalog.regclass, 'occ.iam_restrictions'::pg_catalog.regclass
        )
        AND mode = 'ShareLock'
    ) THEN
      RAISE EXCEPTION 'native IAM read barrier cannot upgrade' USING ERRCODE = '25001';
    END IF;
    LOCK TABLE occ.iam_identities, occ.iam_roles, occ.iam_groups,
      occ.iam_group_memberships, occ.iam_access_bindings, occ.iam_restrictions
      IN SHARE ROW EXCLUSIVE MODE;
  ELSE
    LOCK TABLE occ.iam_identities, occ.iam_roles, occ.iam_groups,
      occ.iam_group_memberships, occ.iam_access_bindings, occ.iam_restrictions
      IN SHARE MODE;
  END IF;

  -- Restore only the setting; successful table and advisory locks remain held
  -- until transaction settlement. Do not catch failures: transaction/savepoint
  -- rollback restores the setting and releases any locks acquired by that scope.
  PERFORM pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
END;
$$;

REVOKE ALL ON FUNCTION occ.native_iam_policy_barrier(text, boolean) FROM PUBLIC, occ_app;
GRANT EXECUTE ON FUNCTION occ.native_iam_policy_barrier(text, boolean) TO occ_app;

COMMIT;

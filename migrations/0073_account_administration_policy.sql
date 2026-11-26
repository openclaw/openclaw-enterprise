-- Administrative account changes must keep the policy they authorize against until COMMIT.
-- NOWAIT avoids reversing the row-lock order of ordinary Namespace policy writers.
CREATE FUNCTION occ.hold_account_administration_policy(installation_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  IF installation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM occ.installation WHERE id = installation_id
  ) THEN
    RAISE EXCEPTION 'account administration requires the current Installation'
      USING ERRCODE = '23514';
  END IF;
  LOCK TABLE occ.iam_identities, occ.iam_roles, occ.iam_groups,
    occ.iam_group_memberships, occ.iam_access_bindings, occ.iam_restrictions
    IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.hold_account_administration_policy(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.hold_account_administration_policy(text) TO occ_app;

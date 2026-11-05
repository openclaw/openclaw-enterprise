-- Keep a mapping's exact target across configuration removal. Each activation gets a
-- fresh generation; a local denial survives reactivation of that same target.
CREATE TABLE occ.github_roster_mappings (
  key uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id LIKE 'github:%'),
  organization_id text NOT NULL CHECK (organization_id ~ '^[1-9][0-9]{0,19}$'),
  team_id text NOT NULL CHECK (team_id ~ '^[1-9][0-9]{0,19}$'),
  group_id text NOT NULL CHECK (group_id LIKE 'group\_config\_%'),
  generation uuid,
  refresh_id uuid,
  next_refresh_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz,
  last_successful_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','unavailable')),
  UNIQUE (mapping_id, provider_id, organization_id, team_id, group_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX github_roster_mapping_active_id ON occ.github_roster_mappings (mapping_id)
WHERE generation IS NOT NULL;
--> statement-breakpoint
-- PostgreSQL's FK check sees a concurrently created source even when a direct
-- identity writer's older snapshot cannot see it in the cleanup trigger.
ALTER TABLE occ.account ADD CONSTRAINT account_id_authentication_version_unique
  UNIQUE (id, authentication_version);
--> statement-breakpoint
CREATE TABLE occ.github_roster_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_key uuid NOT NULL REFERENCES occ.github_roster_mappings(key),
  method_id text NOT NULL,
  method_version integer NOT NULL,
  denied boolean NOT NULL DEFAULT false,
  override_version uuid,
  sign_in_id uuid,
  refresh_id uuid,
  FOREIGN KEY (method_id, method_version) REFERENCES occ.account(id, authentication_version)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  UNIQUE (mapping_key, method_id)
);
--> statement-breakpoint
CREATE INDEX github_roster_sources_method ON occ.github_roster_sources(method_id);
--> statement-breakpoint
-- NULL is the pre-existing default/manual/unknown source. Keep it permanently
-- independent of every mapped admission, including when inserted after a roster grant.
ALTER TABLE occ.iam_group_memberships
  ADD COLUMN roster_source_id uuid REFERENCES occ.github_roster_sources(id) ON DELETE CASCADE,
  DROP CONSTRAINT iam_group_memberships_group_principal_unique,
  ADD CONSTRAINT iam_group_memberships_group_principal_source_unique
    UNIQUE NULLS NOT DISTINCT (group_id, principal_id, roster_source_id),
  ADD CONSTRAINT iam_group_memberships_roster_scope CHECK (
    roster_source_id IS NULL OR (namespace_id IS NULL AND group_id LIKE 'group\_config\_%')
  );
--> statement-breakpoint
CREATE UNIQUE INDEX iam_group_memberships_roster_source ON occ.iam_group_memberships(roster_source_id)
WHERE roster_source_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON occ.github_roster_mappings, occ.github_roster_sources TO occ_app;
--> statement-breakpoint
-- An account UPDATE or DELETE owns the method row before this trigger. Fence the
-- loss of a mapped attachment against OCC's ordinary durable authority writers too.
CREATE FUNCTION occ.remove_replaced_github_roster_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
BEGIN
  -- A writer's old snapshot can predate the attachment's first roster source.
  -- Take the lock before inspecting sources, including before an FK cascade.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('occ:iam-configuration', 0));
  DELETE FROM occ.github_roster_sources WHERE method_id = OLD.id;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER github_roster_attachment_replaced
BEFORE UPDATE OF user_id, provider_id, account_id, identity_only ON occ.account
FOR EACH ROW WHEN (OLD.identity_only AND
  (OLD.user_id, OLD.provider_id, OLD.account_id, OLD.identity_only)
    IS DISTINCT FROM (NEW.user_id, NEW.provider_id, NEW.account_id, NEW.identity_only)
) EXECUTE FUNCTION occ.remove_replaced_github_roster_attachment();
--> statement-breakpoint
CREATE TRIGGER github_roster_attachment_removed
BEFORE DELETE ON occ.account FOR EACH ROW WHEN (OLD.identity_only)
EXECUTE FUNCTION occ.remove_replaced_github_roster_attachment();
--> statement-breakpoint
GRANT DELETE ON occ.github_roster_sources TO occ_app;
--> statement-breakpoint
-- The override authorizes against all six native policy inputs on its original
-- transaction. Direct policy writers already take relation locks when they mutate
-- these tables. Refuse on contention before observing policy or changing the target.
CREATE FUNCTION occ.hold_github_roster_override_policy() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  LOCK TABLE occ.iam_identities, occ.iam_roles, occ.iam_groups, occ.iam_group_memberships,
    occ.iam_access_bindings, occ.iam_restrictions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  RETURN true;
EXCEPTION WHEN lock_not_available THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.hold_github_roster_override_policy() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.hold_github_roster_override_policy() TO occ_app;

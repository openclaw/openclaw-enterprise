import { createHash } from "node:crypto";

// Compare PostgreSQL definitions and effective application privileges without
// including instance-specific OIDs, row counts or sequence positions.
const catalogSql = `
WITH objects AS (
  SELECT 'relation' AS kind, c.relname::text AS name,
    jsonb_build_array(c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
      c.relowner = current_user::regrole, c.reloptions, c.relreplident, c.relispartition,
      CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, false) END) AS value
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
  UNION ALL
  SELECT 'column', c.relname || '.' || a.attname,
    jsonb_build_array(format_type(a.atttypid, a.atttypmod), a.attnotnull,
      a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid),
      CASE WHEN a.attcollation <> 0 THEN a.attcollation::regcollation::text END,
      ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
        WHERE has_column_privilege('occ_app', c.oid, a.attnum, p) ORDER BY p))
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', COALESCE(c.relname || '.', '') || co.conname,
    jsonb_build_array(pg_get_constraintdef(co.oid, false), co.convalidated,
      co.condeferrable, co.condeferred)
  FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_namespace n ON n.oid = co.connamespace
  LEFT JOIN pg_catalog.pg_class c ON c.oid = co.conrelid WHERE n.nspname = $1 AND co.contype <> 'n'
  UNION ALL
  SELECT 'index', c.relname, jsonb_build_array(pg_get_indexdef(i.indexrelid),
      i.indisvalid, i.indisready, i.indislive)
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text,
    jsonb_build_array(pg_get_functiondef(p.oid), p.proowner = current_user::regrole,
      has_function_privilege('occ_app', p.oid, 'EXECUTE'))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = $1
  UNION ALL
  SELECT 'trigger', c.relname || '.' || t.tgname,
    jsonb_build_array(pg_get_triggerdef(t.oid, false), t.tgenabled)
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND NOT t.tgisinternal
  UNION ALL
  SELECT 'sequence', c.relname, jsonb_build_array(format_type(s.seqtypid, NULL),
      s.seqstart, s.seqincrement, s.seqmax, s.seqmin, s.seqcache, s.seqcycle)
  FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
  UNION ALL
  SELECT 'type', t.typname, jsonb_build_array(t.typtype, format_type(t.typbasetype, NULL),
      t.typnotnull, t.typdefault, t.typowner = current_user::regrole,
      ARRAY(SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder))
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = $1 AND t.typrelid = 0 AND t.typelem = 0
  UNION ALL
  SELECT 'policy', c.relname || '.' || p.polname,
    jsonb_build_array(p.polcmd, p.polpermissive, pg_get_expr(p.polqual,p.polrelid),
      pg_get_expr(p.polwithcheck,p.polrelid),
      ARRAY(SELECT CASE WHEN r=0 THEN 'public' ELSE r::regrole::text END FROM unnest(p.polroles) r ORDER BY 1))
  FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
), acl AS (
  SELECT 'relation' AS kind, c.relname AS name, c.relowner AS owner,
    COALESCE(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner)) AS privileges
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT 'column', c.relname || '.' || a.attname, c.relowner, a.attacl
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text, p.proowner, COALESCE(p.proacl,acldefault('f',p.proowner))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
)
SELECT kind, name, value FROM objects
UNION ALL
SELECT 'acl:' || a.kind, a.name, jsonb_agg(jsonb_build_array(
  CASE WHEN x.grantor=a.owner THEN 'owner' ELSE x.grantor::regrole::text END,
  CASE WHEN x.grantee=0 THEN 'public' WHEN x.grantee=a.owner THEN 'owner' ELSE x.grantee::regrole::text END,
  x.privilege_type,x.is_grantable) ORDER BY x.privilege_type,
  CASE WHEN x.grantee=0 THEN 'public' WHEN x.grantee=a.owner THEN 'owner' ELSE x.grantee::regrole::text END,
  CASE WHEN x.grantor=a.owner THEN 'owner' ELSE x.grantor::regrole::text END)
FROM acl a CROSS JOIN LATERAL aclexplode(a.privileges) x GROUP BY a.kind,a.name
UNION ALL
SELECT 'effective-table-acl',c.relname,to_jsonb(ARRAY(SELECT p FROM unnest(
  ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
  WHERE has_table_privilege('occ_app',c.oid,p) ORDER BY p))
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f')
ORDER BY kind,name`;

export async function migrationCatalog(client, schema = "occ") {
  const previous = await client.query("SHOW search_path");
  await client.query("SET search_path = pg_catalog, pg_temp");
  try {
    const { rows } = await client.query(catalogSql, [schema]);
    const otherObjects = await client.query(
      `
      SELECT 'other-object' AS kind, i.identity AS name, to_jsonb(i.type) AS value
      FROM pg_catalog.pg_depend d
      JOIN pg_catalog.pg_namespace n ON n.oid=d.refobjid
      CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid,d.objid,d.objsubid) i
      WHERE d.refclassid='pg_catalog.pg_namespace'::regclass AND n.nspname=$1
        AND d.classid NOT IN ('pg_catalog.pg_class'::regclass,'pg_catalog.pg_proc'::regclass,
          'pg_catalog.pg_type'::regclass,'pg_catalog.pg_constraint'::regclass)
      ORDER BY i.identity`,
      [schema],
    );
    rows.push(...otherObjects.rows);
    if (rows.length > 0) {
      const privileges = await client.query(
        `
        SELECT 'schema' AS kind, nspname::text AS name, jsonb_build_array(
          nspowner=current_user::regrole,
          pg_catalog.has_schema_privilege('occ_app',oid,'USAGE'),
          pg_catalog.has_schema_privilege('occ_app',oid,'CREATE'),
          (SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantor=nspowner THEN 'owner' ELSE x.grantor::regrole::text END,
            CASE WHEN x.grantee=0 THEN 'public' WHEN x.grantee=nspowner THEN 'owner' ELSE x.grantee::regrole::text END,
            x.privilege_type,x.is_grantable) ORDER BY x.privilege_type,
            CASE WHEN x.grantee=0 THEN 'public' WHEN x.grantee=nspowner THEN 'owner' ELSE x.grantee::regrole::text END)
           FROM pg_catalog.aclexplode(COALESCE(nspacl,pg_catalog.acldefault('n',nspowner))) x)) AS value
        FROM pg_catalog.pg_namespace WHERE nspname=$1`,
        [schema],
      );
      rows.push(...privileges.rows);
    }
    {
      const defaults = await client.query(
        `
        SELECT 'default-acl' AS kind,
          CASE WHEN d.defaclrole=current_user::regrole THEN 'owner' ELSE d.defaclrole::regrole::text END || '.' ||
          CASE WHEN d.defaclnamespace=0 THEN '*' ELSE n.nspname END || '.' || d.defaclobjtype::text AS name,
          COALESCE((SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantor=d.defaclrole THEN 'owner' ELSE x.grantor::regrole::text END,
            CASE WHEN x.grantee=0 THEN 'public' WHEN x.grantee=d.defaclrole THEN 'owner' ELSE x.grantee::regrole::text END,
            x.privilege_type,x.is_grantable) ORDER BY x.privilege_type,
            CASE WHEN x.grantee=0 THEN 'public' WHEN x.grantee=d.defaclrole THEN 'owner' ELSE x.grantee::regrole::text END,
            CASE WHEN x.grantor=d.defaclrole THEN 'owner' ELSE x.grantor::regrole::text END,
            x.is_grantable)
            FROM pg_catalog.aclexplode(d.defaclacl) x), '[]'::jsonb) AS value
        FROM pg_catalog.pg_default_acl d
        LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
        WHERE (d.defaclrole=current_user::regrole AND d.defaclnamespace=0) OR n.nspname=$1
        ORDER BY name`,
        [schema],
      );
      rows.push(...defaults.rows);
    }
    return rows
      .map((row) => [JSON.stringify(row), row])
      .sort(([a], [b]) => {
        if (a === b) {
          return 0;
        }
        return a < b ? -1 : 1;
      })
      .map(([, row]) => row);
  } finally {
    await client.query("SELECT pg_catalog.set_config('search_path', $1, false)", [
      previous.rows[0].search_path,
    ]);
  }
}

// Empty schemas require an exact ACL and default-privilege check before DDL.
export async function initialSchemaState(client, schema) {
  const { rows } = await client.query(
    `
    SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
      COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          pg_catalog.pg_get_userbyid(x.grantor),
          CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
          x.privilege_type, x.is_grantable)
          ORDER BY x.privilege_type, x.grantee, x.grantor, x.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(n.nspacl,
          pg_catalog.acldefault('n', n.nspowner))) x
      ), '[]'::pg_catalog.jsonb) AS privileges,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_depend d
        WHERE d.refclassid='pg_catalog.pg_namespace'::pg_catalog.regclass
          AND d.refobjid=n.oid) AS objects,
      (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_default_acl d
        LEFT JOIN pg_catalog.pg_namespace s ON s.oid=d.defaclnamespace
        WHERE (d.defaclrole=current_user::pg_catalog.regrole AND d.defaclnamespace=0)
          OR s.nspname IN ('occ', 'drizzle')) AS "defaultPrivileges",
      pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE')
        AS "databaseCreate"
    FROM (VALUES ($1::pg_catalog.text)) requested(name)
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=requested.name`,
    [schema],
  );
  return rows[0];
}

export function catalogDigest(catalog) {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

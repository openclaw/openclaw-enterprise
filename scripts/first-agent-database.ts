type Database = (sql: string, variables: Record<string, string>) => Promise<string>;

export async function findFirstAgentSecret(
  database: Database,
  namespaceId: string,
  secretName: string,
): Promise<string | undefined> {
  const result = await database(
    `SELECT secret.id
       FROM occ.secrets AS secret
       JOIN occ.namespaces AS namespace ON namespace.id = secret.namespace_id
      WHERE namespace.id = :'namespace_id'
        AND namespace.deleted_at IS NULL
        AND namespace.status <> 'deleting'
        AND secret.name = :'secret_name';`,
    { namespace_id: namespaceId, secret_name: secretName },
  );
  const ids = result.trim().split(/\r?\n/u).filter(Boolean);
  const [id] = ids;
  if (id === undefined) {
    return undefined;
  }
  if (ids.length !== 1 || !/^sec_[a-f\d-]+$/u.test(id)) {
    throw new Error("The local database returned an unexpected Secret lookup result.");
  }
  return id;
}

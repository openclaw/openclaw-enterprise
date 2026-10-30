-- The connection-template binding validator is privileged. Retain the lookup order from 0026.
ALTER FUNCTION occ.validate_access_binding_scope()
  SET search_path = pg_catalog, occ, pg_temp;

-- The initial token response records the provider's grant independently of the consent request.
-- The saved-connection update trigger still limits each renewal to the preceding grant.
ALTER TABLE occ.saved_connections
  DROP CONSTRAINT saved_connections_granted_scopes,
  ADD CONSTRAINT saved_connections_granted_scopes
    CHECK (array_position(granted_scopes, NULL) IS NULL);

-- Existing revisions and writers that omit the mode retain a NULL value.
ALTER TABLE occ.agent_revisions
  ADD COLUMN network_egress_mode text,
  ADD CONSTRAINT agent_revisions_network_egress_mode CHECK (
    network_egress_mode IS NULL OR network_egress_mode IN ('public', 'restricted')
  );

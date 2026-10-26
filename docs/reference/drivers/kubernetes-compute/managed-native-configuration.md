# Managed native configuration

This page is part of the [Kubernetes storage and credentials](storage-and-credentials.md) reference.

Ordinary runtime gateways read the managed ConfigMap at
`/etc/openclaw/openclaw.json`. Native admin editing uses a writable copy only
when runtime gateway images and private `gatewayRouting` are configured and
the saved native Configuration explicitly enables the pilot shape:

- Trusted-proxy authentication accepts `x-occ-identity: occ-workspace-files`
  with `operator.admin` identity scopes.
- Trusted-proxy device auto-approval is enabled with `operator.admin` scope.
- `controlUi.enabled` is true and `controlUi.allowedOrigins` is nonempty.
- Dangerous device-auth disabling and host-header origin fallback are disabled.

For those gateways, the managed ConfigMap remains read-only at
`/etc/openclaw-managed/openclaw.json`. The nonroot init container copies it to
`/home/node/.openclaw/openclaw.json` on the Pod-local `emptyDir`, and
`OPENCLAW_CONFIG_PATH` points to that writable copy. Gateways without the full
opt-in shape, including ordinary routed gateways, keep the read-only path.

Native edits change only the copy; Pod replacement or Agent redeployment
restores the managed snapshot, while the persistent gateway and workspace claims
retain their data. Pod-local provenance records Agent revision ID, snapshot hash and
generated bridges; only matches with the managed baseline are rebuilt.
Peer recovery and same-Pod restarts retain unrelated edits; conflicting bridge
edits remain refused. Pod replacement clears copy/provenance.
Edits stay outside OCE Configuration and AgentRevisions; see
the [native admin feature boundary](../../agent-native-admin.md#native-authority-and-drift)
and [deployment procedure](../../../guides/deploy/native-admin.md).

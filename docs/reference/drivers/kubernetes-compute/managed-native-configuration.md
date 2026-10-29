# Managed native configuration

This page is part of the [Kubernetes storage and credentials](storage-and-credentials.md) reference.

With [Gateway managed mode](../../agent-native-admin.md#gateway-managed-mode) off,
Kubernetes gives the Gateway a writable copy of its native configuration.
With managed mode on, Kubernetes creates that copy only when the deployment uses
runtime Gateway images and private `gatewayRouting`, and the saved Configuration
meets the following native admin requirements.

- Trusted-proxy authentication accepts `x-occ-identity: occ-workspace-files`
  with `operator.admin` identity scopes.
- Trusted-proxy device auto-approval is enabled with `operator.admin` scope.
- `controlUi.enabled` is true and `controlUi.allowedOrigins` is nonempty.
- Dangerous device-auth disabling and host-header origin fallback are disabled.

For those gateways, the managed ConfigMap remains read-only at
`/etc/openclaw-managed/openclaw.json`. The nonroot init container copies it to
`/home/node/.openclaw/openclaw.json` on the Pod-local `emptyDir`, and
`OPENCLAW_CONFIG_PATH` points to that writable copy. Other managed Gateways read the ConfigMap directly at
`/etc/openclaw/openclaw.json`.

Native edits change only the copy; Pod replacement or Agent redeployment
restores the managed snapshot, while the persistent gateway and workspace claims
retain their data. Pod-local provenance records Agent revision ID, snapshot hash and
generated bridges; only matches with the managed baseline are rebuilt.
Peer recovery and same-Pod restarts retain unrelated edits; conflicting bridge
edits remain refused. Pod replacement clears copy/provenance.
Edits stay outside OCE Configuration and AgentRevisions; see
the [native admin feature boundary](../../agent-native-admin.md#native-authority-and-drift)
and [deployment procedure](../../../guides/deploy/native-admin.md).

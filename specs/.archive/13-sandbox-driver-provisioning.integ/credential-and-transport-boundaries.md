# Integration Plan: SandboxDriver OpenShell Kubernetes: credential and transport boundaries

[Spec overview](../13-sandbox-driver-provisioning.integ.md). Original record; decisions and status are preserved.

## Test-only credential bridge

The current OpenShell Kubernetes driver does not expose the required
`secretKeyRef` environment configuration. The integration fixture works around
that limitation without modifying upstream OpenShell:

1. A short-lived fixture-owned Kubernetes Job receives the exact existing
   `APP_SERVER_TOKEN` and `OPENAI_API_KEY` through Kubernetes Secret references.
2. The Job mounts only a revision-scoped credential subpath of the existing
   Agent PVC, writes both values without logging them, and restricts directory
   and file permissions to the Harness UID.
3. The integration SandboxDriver adds a read-only mount of that same subpath at
   `/run/enterprise-credentials`.
4. The startup wrapper loads the files into the normal Codex environment and
   then executes the unmodified dedicated Harness entrypoint:

```sh
export APP_SERVER_TOKEN="$(cat /run/enterprise-credentials/app-server-token)"
export OPENAI_API_KEY="$(cat /run/enterprise-credentials/openai-api-key)"

exec "$@"
```

The credential directory is a sibling of the approved `workspace`, `sessions`,
`generated-images`, `bundled-skills`, and `plugin-skills` subpaths. It must not
appear under `/home/node/workspace`; neither the helper nor the Harness should
mount the PVC root. Delete the helper and credential files during cleanup and
never print values in commands, logs, Agent output, snapshots, or assertions.

This is an explicit test-only deviation: the extra credential PVC mount and
helper Job do not prove production `secretKeyRef` support, brokered delivery,
or the normal guarantee that the model credential exists only in its final
Harness Pod. Use fixture-scoped Kubernetes authority for the helper rather than
granting production Compute broader Secret, Pod, or Job permissions.

Current OpenShell also rejects projected ServiceAccount token volumes in its
gateway driver configuration. Production must fail closed until upstream
supports the exact approved projected volume and read-only Harness mount. The
integration fixture alone may remove the unsupported request field, suspend the
provider-created Sandbox, patch its Pod template with Compute's unchanged
audience, expiration, token path, and read-only mount, then resume the Sandbox
before returning control to Compute. This operator-owned compatibility bridge
does not grant production drivers additional authority or substitute a static
credential or OpenShell gateway token.

If OpenShell requires one existing mount under `/sandbox` to suppress its
default PVC, add a read-only alias of an approved existing subpath for this test.
Never mount the Agent PVC root and record that extra alias as another fixture
deviation rather than production workspace-conformance proof.

## Dedicated WebSocket transport

The OpenClaw gateway and Codex Harness share the existing real
`APP_SERVER_TOKEN`. Codex listens on `0.0.0.0:18790`; the gateway authenticates
its connection to `ws://agent-<id>:18790`. Preserve the Compute-owned Service,
expected revision labels, and existing gateway-to-Harness NetworkPolicies.

Use direct Service-to-Sandbox-Pod routing. OpenShell sidecar topology exposes
the provider-owned Pod through the existing Compute-owned selector-based
Service and narrowly scoped NetworkPolicies:

```text
OpenClaw gateway -> Compute-owned Service -> OpenShell Harness Pod
```

The real integration has verified this native route against OpenShell
`v0.0.113`; no forwarding Pod, supervisor relay, or alternate routing adapter
is needed. If direct routing fails, fail the integration explicitly.

## Hardcoded outbound network policy

Configure OpenShell with default-deny egress and an endpoint allowlist
equivalent to:

```yaml
network_policies:
  openclaw:
    name: openclaw
    endpoints:
      - host: www.openclaw.org
        port: 443

  model_provider:
    name: model-provider
    endpoints:
      - host: api.openai.com
        port: 443
```

Add only the actual model/authentication hosts required by the selected Codex
credential and model. Do not allow `acme.com`. DNS, OpenShell gateway callbacks,
and trusted control-plane traffic are infrastructure prerequisites, not
blanket user-egress exceptions.

Kubernetes NetworkPolicy must permit the OpenShell network sidecar's approved
outbound path and gateway-to-Harness transport while retaining the existing
default-deny baseline. OpenShell performs hostname-level allow/deny enforcement
inside that Kubernetes network envelope. Additive Kubernetes policies must not
silently make denied Agent traffic reachable outside the OpenShell boundary.


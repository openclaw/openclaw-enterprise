# Use an external OpenShell gateway

Replace the [local OpenShell profile](local-kubernetes-development.md#start-the-openshell-fail-closed-profile)'s
pinned in-cluster gateway with one you already operate, authenticated by an
OIDC client-credentials grant. The control plane, compute cluster, and Agent
workflow stay the same.

## Select the gateway

Export the four `OCC_DEVELOPMENT_OPENSHELL_*` variables from the
[environment variables cheat sheet](../../reference/cheatsheets/environment-variables.md)
before `./scripts/dev-up`:

```bash
export OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT=https://openshell-gateway.example.com:8443
export OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL=https://idp.example.com/realms/openshell/protocol/openid-connect/token
export OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_ID=occ-development
export OCC_DEVELOPMENT_OPENSHELL_OIDC_CLIENT_SECRET_FILE=/secure/openshell-client-secret
```

The endpoint must be an `https` origin without a path; the token URL must be
`https` (or `http` to a numeric loopback address), and the client-secret file
must exist and be nonempty. The four variables select the external gateway
together or not at all. The [protected profile](local-openshell-images.md#select-the-protected-profile)
cannot select an external gateway; the launcher refuses that combination.

## What the launcher changes

The launcher still installs the Agent Sandbox controller, RuntimeClass, and
workspace chart in its k3d cluster, but skips the in-cluster gateway, its
images, and its JWT assets. The Installation's `openshell` Backend
authenticates with an OIDC client-credentials grant (see the
[OpenShell Backend](../../reference/backends.md#openshell-gateway) reference),
and the profile's NetworkPolicies admit the API, worker, and supervisor
callbacks to the gateway's resolved addresses. The client secret is copied into
the private state directory and mounted read-only into the OCC API and worker.

## Prepare the gateway

The external gateway must reconcile Workspaces in the launcher's cluster:

1. configure its Kubernetes driver for `workspaceMode: operator` with the
   `openshell.ai/openclaw-workspace` namespace selector the profile applies;
2. give it access to the launcher's cluster; and
3. expect the audience you request in its OIDC validation (OpenShell's default
   is `openshell-cli`, which is the gateway's expected audience, not the client
   ID).

The credentialed OpenShell proofs in the
[testing guide](../../testing/openshell.md) run against the profile's own
gateway; run them on a profile without this selection.

## Limits

The token request uses the API and worker's system trust store;
`rootCertificatePath` applies to the gRPC channel only, so an issuer with a
private CA is out of scope for this profile. A production Installation using
`oidcClientCredentials` must admit the issuer in its own egress configuration
(`auth.oidc.egressCidrs` covers console sign-in only).

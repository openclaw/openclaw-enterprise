# Set up per-request model credential authorization

Use this path to give a dedicated Codex Agent access to one admitted OpenAI
Responses model while keeping the API key outside the guest. It requires an
explicit `online-request` source and a qualified OpenShell installation.
The source implementation is available; it does not establish qualification of
an installed OpenShell and Codex pair. Complete the checks below before rollout.

This profile checks permission before releasing a credential for each request.
A request whose credential was already released may finish after withdrawal.
It does not provide exact dispatch or full-response inspection. Read the
[contract](../../reference/drivers/credential-proxy.md#online-model-requests)
before choosing this guarantee. Existing strict sources keep their original
profile; a failed strict admission does not select this path automatically.

## Prepare the trusted request path

Use [native IAM](../../reference/drivers/iam.md#native-iam-behavior) backed by
this Installation's OCC state. This profile rejects external IAM and custom
authorization overrides at source creation/update, Agent admission and request
authorization. Existing strict profiles keep their IAM behavior.

Select matching Sandbox and Credential Proxy capabilities with Kubernetes
Compute. Keep the Credential Gateway selected for source metadata ownership.
The model key is resolved through Credential Proxy; this path creates no Gateway
key copy or attachment. Follow the existing [authority setup](../credential-proxy.md#prepare-enforcement-trust-and-custody)
for the TLS certificate, Gateway issuer public key and trusted client selectors.

Configure a separate model middleware name and token-grant listener under
`drivers.credential_proxy.configuration`. Alongside `middlewareName` and
`authority`, add this fragment for a Gateway and supervisor that support provider assertions:

```yaml
tokenGrant:
  endpoint: https://openclaw-enterprise-egress-authority.<namespace>.svc.cluster.local:9445/token
  port: 9445
  assertionSource: openshell_gateway
  issuer: <exact-openshell-gateway-issuer>
  bundlePath: /etc/openclaw/egress/token-grant/bundle.json
```

The token endpoint uses the authority's TLS certificate and a distinct port.
Its HTTPS certificate must cover the endpoint host. Stock OpenShell 0.1.6
uses the supervisor's native CA trust store for token grants and ignores proxy
environment settings. Use a publicly trusted endpoint or a supervisor image
with the required CA in its trust store. The middleware's `tls_ca_cert_path`
does not configure token-grant trust, and the dedicated supervisor configuration
has no token-grant CA override or arbitrary environment/mount extension.

With Helm, enable
`egressAuthority.tokenGrant`, match its `port`, and set `bundleConfigMapName` to
a ConfigMap containing the public JWT trust bundle as `bundle.json`. The chart
mounts that bundle only into the API Pods. Keep `egressAuthority.clients` scoped
to trusted callers. Keep this ConfigMap synchronized with the configured issuer’s public keys,
including key removals. The token listener reads the mounted bundle on each
exchange.

For Gateway assertions, put the Gateway’s public Ed25519 JWKS in
`bundle.json`. Enable Gateway signing and supervisor TLS. Register the
provider’s immutable ID, the `access_token` credential and exact HTTPS token
endpoint with the Gateway before starting the Agent.

For the existing SPIFFE mode, omit `assertionSource` and `issuer` and set
`trustDomain`. Provision the trusted supervisor’s Workload API socket and
registration through the installation’s SPIRE infrastructure. Its JWT-SVID subject must be
`spiffe://<trust-domain>/openshell/sandbox/<sandbox-id>` and its audience must be
the exact token endpoint. This feature does not deploy SPIRE or create those
registrations. Verify that the guest cannot reach the socket or obtain the same
identity. A mounted public trust bundle alone is insufficient.

Register the model middleware as a required pre-credential binding with the
configured HTTPS authority and audience. Set `timeout = "5s"` in the
model middleware registration to allow live installation and IAM checks; this
is a recommended timeout, not a guarantee that a request completes within it.
The existing Gateway-signed extension
identity authenticates that middleware call. A separate assertion with the
token endpoint as its audience authenticates credential redemption. Use a distinct middleware name for
protected Git. The Driver refuses missing mandatory bindings, overlapping model
routes, mismatched provider configuration and token grants without explicit
`cache_ttl: 0`.

## Apply to an existing installation

Both phases restart the Worker. Before a controller-only image upgrade, use
[the deployment inventory](../../reference/repository-credentials/worker-replacement.md)
to identify running revisions that require their original Worker. Stop and
settle those revisions under an authorized interruption or use the runtime
replacement workflow. A replacement Worker cannot adopt a protected Git launch,
even when the same revision also uses request-time model delivery. A new Agent
deployment reuses an active standing approval when its scope is unchanged.
Roll out the image and configuration in two phases:

1. Complete the normal [image upgrade](../deploy/production-upgrade.md), keeping
   existing non-image Installation settings unchanged.
2. From a checkout of the newly installed source revision, apply a separate
   reviewed [Installation configuration change](../deploy/production-installation-changes.md).
   Keep every image reference unchanged and set `database.upgradeMigration: separate`
   during this phase. Preserve the
   Installation Secret's `openclaw.dev/installation-id` annotation, recompute
   `controlPlane.installationChecksum`, and apply the matching `egressAuthority`
   and `egressAuthority.tokenGrant` Helm values with the configuration.

The image-upgrade helper intentionally refuses these configuration changes;
its candidate inputs do not authorize combining the two phases. The separate
configuration change restarts the API and Worker with the new settings.

For an immutable Installation Secret, follow the separate
[same-image successor procedure](../deploy/production-installation-changes.md#change-an-immutable-installation-secret).
It requires an explicit identity comparison with live OCC and retains the
original Secret for recovery; ordinary Helm does not perform that comparison.

## Create and bind the model source

Use the built CLI, a ready Namespace, `OCC_URL`, `OCC_NAMESPACE` and a protected
`OCC_SERVICE_KEY_FILE`. The operator needs source creation and Secret `operate`
permissions. Store the authorized API key as a Namespace Secret using
[Register the key](../deploy/openshell-credential-sources.md#register-the-key),
then use its `SECRET_REF` to create this source instead of that page's default.
Choose the HTTPS `/v1` destination first: use `https://api.openai.com/v1` for
OpenAI, or the controlled origin for the acceptance checks below. The key must
be authorized for that destination. Create the acceptance source with its
controlled destination before deploying the acceptance Agent.

```bash
MODEL_BASE_URL='https://<approved-model-host>/v1'
jq -n --argjson ref "$SECRET_REF" --arg base "$MODEL_BASE_URL" \
  '{name: "model-requests", type: "openai", authorization: "online-request",
    config: {authorized_base_url: $base}, secrets: {api_key: $ref}}' > model-source.json
SOURCE_ID="$(./bin/occ credential-source create --file model-source.json -o json | jq -r .id)"
./bin/occ credential-source get "$SOURCE_ID" -o json
```

Require `type: openai`, `state: ready`, `egress.adoption: live`,
`egress.retention: none` and `ownerCapability: credential_gateway`. The public
response omits the provider ID and authorization profile; these fields alone
do not distinguish online authorization from strict admission. Retain
`model-source.json` with its explicit authorization selection, and complete the
installed-path checks below. Gateway ownership does not mean it holds the key.
A source update retains its selected provider and cannot change authorization
profiles.

Follow [create the Agent and grant the source](../deploy/openshell-credential-sources.md#create-the-agent-and-grant-the-source)
for a dedicated Codex Agent, exact source binding, API-key authentication and
Agent service-principal `operate` permission. Select one authorized model and
the HTTPS Responses provider. The runtime must use the generated custom Codex
provider with WebSockets disabled, not the built-in OpenAI provider's WebSocket
transport. The current profile permits one `/v1/responses` route; it does not
admit Chat Completions or provider-hosted tools.

Before deploying, save the identical destination in the dedicated Codex
Harness's `modelProvider.baseUrl` using [deployment overrides](../topics/agent-revisions.md#choose-a-harness-destination):

```bash
jq -n --arg base "$MODEL_BASE_URL" \
  '{modelProvider: {protocol: "openai-responses", baseUrl: $base}}' \
  > model-harness-overrides.json
./bin/occ agent deploy "$AGENT_ID" --harness-overrides model-harness-overrides.json
```

The source's `config.authorized_base_url` and saved `modelProvider.baseUrl` must
match; changing only the Agent endpoint is refused. Keep the Gateway's
`models.providers.codex.baseUrl` at its fail-closed value from the linked setup.
Check the requested deployment and runtime status. A ready source does not prove
that the workload passed installation checks or can answer a model turn.

## Redeem a prepared Git token with a Gateway assertion

An installation can enable `repository.openShell.grantRedemption` for one
selected read-only `github-repository` grant. Use matching Gateway and
supervisor builds that support provider assertions and dynamic Git HTTP Basic
injection. The held Agent still requires a current prepared token before release.
The Gateway provider stores no copy of that token.

Configure the Worker’s HTTPS `/token` listener on a port separate from its
middleware authority. Set `assertionSource: openshell_gateway`, the exact
Gateway `issuer`, and `bundlePath` to its public JWKS. With Helm, set
`openshellGit.tokenGrant.enabled`, match its `port`, and configure
`bundleConfigMapName` and trusted supervisor `clients`. Register the provider’s
immutable ID, the `access_token` credential and the exact HTTPS endpoint with
the Gateway. Use the existing [supervisor TLS requirements](../../reference/repository-credentials/protected-openshell-git.md#prerequisites).

The middleware first approves the inspected operation. The proxy presents a
separate signed assertion to redeem that approval. The Worker rechecks the
same recipient, grant and material before release, then OpenShell injects the
token into the authorized Git HTTPS request. This profile disables token
caching. Installed candidate qualification remains pending.

## Verify the installed path

Run these checks against the exact images and configuration selected for rollout:

1. Using the controlled origin selected in both source and Harness settings
   before deployment, send an actual Codex model turn and inspect its streamed
   response. Prove that the expected key reaches the allowed
   request while the guest has only a placeholder. Keep keys and SVIDs out of logs.
2. Attempt another model, an unapproved path, a direct route and credential
   redemption without the supervisor identity. Require refusal with no new
   origin request. Confirm the guest cannot access the Workload API socket.
3. Redeem an approval twice; only the first may release material. Withdraw the
   source after approval but before redemption; that redemption must be denied
   with no new origin request.
   Repeat across authority-process restart to check durable approval handling.
4. Rotate the Secret during a held material read. The interrupted selection must
   fail; a subsequent authorized request must use the new version. The short
   token-grant `expires_in` is a release lease, not the API key's provider expiry.
5. In the same Sandbox, verify both inference and native Git. Revoke only the
   model source's IAM grant and confirm that model requests cannot reach their
   origin while authorized Git still works. Restore that grant, then remove
   Git [standing approval](../repository-credentials.md#keep-git-access-on-the-same-running-agent)
   with its current generation. Verify that fresh Git requests are denied with
   no new origin request. Version 9 may retire the entire runtime on Git removal;
   record that outcome. Continued inference after this removal is not guaranteed.

Keep the saved bindings unchanged during these checks. Removing a model or
Git binding may stop or redeploy the execution; version 9 does not support live
policy reduction that keeps the other path running.

Middleware refusal reports `request_credential_denied`. A token response of
`invalid_client` points to identity, trust or audience; `invalid_grant` points to
approval, deadline or current authority. Inspect these separately from provider
errors. Do not work around a refusal by copying the key into the guest or
removing the mandatory binding. The [source-backed flow](../../flows/credential-source-egress/model-requests.md)
shows the checks and their owners.

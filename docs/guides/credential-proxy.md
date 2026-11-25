# Set up and operate Credential Proxy

OCC admits each Credential Source binding. TokenService owns the credential,
Credential Proxy prepares and updates its delivery, and Sandbox enforces the
network policy when the Agent sends a request. See the
[credential Source reference](../reference/credential-sources.md) for the current
contract.

## Choose the path before changing an installation

- For managed model Sources, use OCC TokenService and an OpenShell Sandbox
  registration that exposes native Credential Proxy delivery.
  [Driver selections](../reference/drivers/selection.md#supported-selections)
- For native Git, follow [GitHub App setup](repository-credentials.md#set-github-app-access-for-an-openshell-agent).
  TokenService renews the GitHub installation token, and Credential Proxy
  injects it only on requests admitted for the Agent.
- For credential-free repository metadata, select a qualified protected sender
  and Sandbox registration. The sender restricts the request and its response
  without injecting a credential.
  [Credential-free Source procedure](../reference/credential-sources/protected-repository-metadata.md#register-a-source)
- For the separate Kubernetes prepared Git path without a Sandbox or
  Credential Proxy, use the [prepared native Git reference](../reference/repository-credentials/prepared-native-git.md).

<a id="register-authorize-and-deploy-a-static-source"></a>
<a id="register%2C-authorize%2C-and-deploy-a-static-source"></a>

## Register, authorize, and deploy an OpenAI static inference source

1. Select OCC TokenService and the paired OpenShell Sandbox and native Proxy.
   [Driver selections](../reference/drivers/selection.md#supported-selections)
2. [Register a static Source](../reference/credential-sources/managed-static.md#register-a-source)
   in the Agent's Namespace with the `openai` provider preset.
3. Select the Source in Harness authentication, grant the Agent permission to
   use it, and use the stock preset request grant when available. Save an explicit network grant for a custom runtime.
   [Agent deployment](../reference/credential-sources/managed-static.md#deploy-an-agent-with-the-source)

For a dedicated Codex example, see [first Agent setup](deploy/deploy-first-agent.md).

<a id="enroll-prepared-github-access"></a>

## Enroll GitHub App access

[Register a GitHub App Client and select repositories for the Agent](repository-credentials.md#set-github-app-access-for-an-openshell-agent).
Keep the model Source and Git Source permissions separate.

## Enable Google Workspace requests from a dedicated worker

Live Google Workspace OAuth delivery through the native Proxy remains deferred
to [#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673). Follow the
[Plugin setup guide](topics/openclaw-plugins.md) for managed static Slack MCP setup.

## Verify use, loss, and withdrawal

Wait for successful deployment and verify a fresh
[model response](operate/model-verification.md) through the running Agent. An
unauthenticated request checks the Agent's entry point. To check Proxy enforcement,
use an approved request and a request outside the saved policy. Verify the allowed
request at the upstream and confirm the denied request never reached it.

For credential-free metadata, verify the approved repository read with no
credential injected. Check that the selected sender refuses another repository
or method. Record the selected revision and the enforcement and origin evidence.
[Credential-free Source policy](../reference/credential-sources/protected-repository-metadata.md#bind-a-source-to-an-agent)

For an active managed model Source, [request withdrawal](../reference/credential-sources/withdrawal.md#withdraw-a-source-from-an-agent)
and verify that the affected Agent can no longer use it. Wait for confirmed
detachment or retirement of the affected runtime. To restore model access,
grant and deploy a replacement Source. An upstream request already authorized
may finish.

### Withdraw repository access

Remove the Agent's Source-backed repository selection using its **Repositories**
settings. Check that the deployment's Git delivery is withdrawn and that a fresh
Git read fails. Send a model request through the same Agent to verify that its
independent model credential continues to work. See the [Git withdrawal flow](../flows/agent-repository-credentials.md#2-freeze-a-deployable-revision).

Legacy prepared Git uses a separate standing or finite session procedure.
[Prepared native Git access](../reference/repository-credentials/prepared-native-git.md#what-a-request-authorizes)

<a id="prepare-enforcement-trust-and-custody"></a>

## Configure a legacy protected sender

For protected egress on a qualified release, use matching immutable OpenShell
images and charts. See [local image selection](deploy/local-openshell-images.md).
New local protected static-inference launches are retired. The launcher rejects
`OCC_DEVELOPMENT_PROTECTED_EGRESS=1` and any presence of
`OCC_DEVELOPMENT_OPENSHELL_HOST_GATEWAY_IP` before effects, including with
Kubernetes/OpenShell. See the [retirement notice](deploy/local-openshell-images.md#select-the-protected-profile).

Use this authority configuration for a qualified legacy protected sender. For
static inference, the bundled OpenShell Driver uses it only to recover and
retire revisions already admitted on a matching pre-cutover release. The
Installation selects the same Driver ID in
`backend[].drivers.credential_proxy` and `drivers.credential_proxy`. A bundled
OpenShell authority selection has this shape:

```yaml
drivers:
  credential_proxy:
    id: openshell-egress
    configuration:
      middlewareName: oce-authority
      authorityScope: execution
      authority:
        host: 0.0.0.0
        port: 9444
        certificatePath: /etc/openclaw/egress/tls/tls.crt
        privateKeyPath: /etc/openclaw/egress/tls/tls.key
        issuerPublicKeyPath: /etc/openclaw/egress/issuer/issuer.pub
        issuer: openshell-gateway:openshell-gateway
        audience: oce-egress
        keyId: current
```

This is a fragment, not a complete Installation. Match issuer, audience, key ID,
and middleware name to the configured peers. Keep the
[OpenShell Backend configuration](../reference/backends.md#openshell-gateway).
A packaged Driver instead takes configuration through its Sandbox selection;
its matching Credential Proxy selection has an empty `configuration`.
Either kind can add `requestCapacity` to size OCC's in-memory request bounds; see
[request-time capacity](../reference/drivers/credential-proxy.md#request-time-capacity).

The API owns the static authority listener. Development binds only to loopback.
Production needs a reachable host and a certificate covering the Service DNS
name. With Helm, use `host: 0.0.0.0` (or `::`) and the `egressAuthority.port`
value. Startup and the upgrade check refuse another host or port, a disabled
`egressAuthority`, or file paths other than the chart mounts shown above, with
`CHART_LISTENER_MISMATCH`. The Backend requires HTTPS
with bearer-file or mutual TLS authentication. Register `oce-authority` under
`[[openshell.supervisor.middleware]]` with its HTTPS `grpc_endpoint`, `audience`,
`tls_ca_cert_path`, and `max_payload_bytes = 4194304`. Both peers must support
`openshell.supervisor-middleware.http-credential-access.v1` and all five capabilities
required by [connected qualification](../testing/static-egress.md#select-the-prepared-connected-lane).
Verify the Agent's WSS server trust separately from the controller's Backend mTLS;
an administrator client Secret must never be projected into the Agent. See
[trust prerequisites](../testing/static-egress.md#protected-launch-packaging).

With Helm, enable `egressAuthority`, set its `port`, `tlsSecretName` (`tls.crt`,
`tls.key`), and `issuerSecretName` (`public.pem`). Its `clients` must select the
actual Gateway and trusted supervisor namespaces and Pod labels. Allow those
peers to reach the authority and resolve DNS. Keep upstream access constrained
to the selected endpoints. The Gateway signing private key stays with the
Gateway; the authority receives its public key. All phases of an exchange must
reach the same authority process; replicated shared exchange state is unavailable.

## Diagnose before retrying

- For a failed Source, check its status and reason. If the new value was
  committed and delivery failed, [retry delivery](deploy/credential-lifecycle.md#replace-an-occ-tokenservice-managed-model-key).
- If the Proxy cannot reach OpenShell, check the management endpoint, TLS
  trust, Driver selections, and the affected Agent revision.
- For pending withdrawal, inspect the reported reason and
  [withdrawal recovery](../reference/credential-sources/withdrawal.md#withdraw-a-source-from-an-agent).
  Retain custody and operation evidence until the selected owner verifies the
  outcome.
- If a protected sender is unqualified, follow the
  [qualified sender prerequisites](../reference/drivers/selection.md#select-a-protected-sender).
  Keep the admitted scope in place.

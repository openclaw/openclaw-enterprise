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
- Credential-free repository metadata uses a qualified protected sender
  and Sandbox registration. The sender restricts the request and its response
  without injecting a credential. This capability still depends on the deprecated
  legacy egress Driver.
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

Prepared Git uses a separate standing or finite session procedure.
[Prepared native Git access](../reference/repository-credentials/prepared-native-git.md#what-a-request-authorizes)

<a id="prepare-enforcement-trust-and-custody"></a>
<a id="configure-a-legacy-protected-sender"></a>

## Existing legacy protected exchanges

`LegacyEgressProxyDriver` and its `drivers.credential_proxy` selection are
deprecated and pending removal. They remain required for qualified protected
repository exchanges and credential-free metadata until those capabilities move
to another owner or are retired. Do not select this Driver for new credentialed
model, Git, or Plugin workflows; use TokenService and native Credential Proxy.
Sandbox network policy and ordinary Channel egress are separate capabilities.

For an existing qualified exchange, retain its matching release, authority,
trust, and peer configuration. See the [historical protected-sender setup](https://github.com/openclaw/openclaw-enterprise/blob/105ffee9962176cf42fc7cfe013b8b94831435db/docs/guides/credential-proxy.md#prepare-enforcement-trust-and-custody)
and [qualified sender prerequisites](../reference/drivers/selection.md#select-a-protected-sender).
New local protected static-inference launches are [retired](deploy/local-openshell-images.md#select-the-protected-profile).

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

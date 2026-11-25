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
- For public GitHub metadata, admit ordinary network access to the endpoint.
  GitHub returns its full response; no CredentialSource or credential injection is
  involved. The Git grant does not authorize GitHub REST. Configure only the
  restrictions supported by the selected Sandbox; current per-Agent policy
  additions use executable, host, and port grants. [Sandbox network policy](../reference/sandbox-policies.md)
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

<a id="enable-google-workspace-requests-from-a-dedicated-worker"></a>

## Connect a Plugin account

Use the [Plugin setup guide](topics/openclaw-plugins.md) to connect an OAuth account or select a static MCP Source. Live Slack OAuth tool execution and an unselected-tool denial were verified in [#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673); live Google OAuth and static Slack tool execution remain unverified.

## Verify use, loss, and withdrawal

Wait for successful deployment and verify a fresh
[model response](operate/model-verification.md) through the running Agent. An
unauthenticated request checks the Agent's entry point. To check Proxy enforcement,
use an approved request and a request outside the saved policy. Verify the allowed
request at the upstream and confirm the denied request never reached it.

For public metadata, verify the separately admitted network access and confirm
that the request needs no credential. This path returns GitHub's response
without the legacy sender's field filtering.

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

The legacy Driver and its `drivers.credential_proxy` setting are retired.
Startup rejects the setting. Use TokenService with the bundled OpenShell
Sandbox for managed credentials.

Settle work accepted by an earlier release with the original owner. See the
[historical sender setup](https://github.com/openclaw/openclaw-enterprise/blob/105ffee9962176cf42fc7cfe013b8b94831435db/docs/guides/credential-proxy.md#prepare-enforcement-trust-and-custody)
and [release-specific prerequisites](../reference/drivers/selection.md#select-a-protected-sender).

## Diagnose before retrying

- For a failed Source, check its status and reason. If the new value was
  committed and delivery failed, [retry delivery](deploy/credential-lifecycle.md#replace-an-occ-tokenservice-managed-model-key).
- If the Proxy cannot reach OpenShell, check the management endpoint, TLS
  trust, Driver selections, and the affected Agent revision.
- For pending withdrawal, inspect the reported reason and
  [withdrawal recovery](../reference/credential-sources/withdrawal.md#withdraw-a-source-from-an-agent).
  Retain custody and operation evidence until the selected owner verifies the
  outcome.

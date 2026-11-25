# Deploy your first Agent

Deploy a dedicated Codex Agent with OCC TokenService and the native OpenShell Credential Proxy.

<a id="evaluate-the-tokenservice-and-credential-proxy-cutover"></a>
<a id="deploy-on-a-pre-cutover-release"></a>

## Prepare the Installation

Complete [local k3d](local-setup.md), [Kubernetes](kubernetes-setup.md), or
[Amazon EKS](eks-openshell-setup.md) setup. Continue in the same operator Bash
session at the root of the matching release checkout. Use the API connection,
Namespace, and browser origin from setup.

This workflow uses bundled Kubernetes Compute, OCC TokenService, and the
OpenShell Sandbox that provides native Credential Proxy delivery.
[Driver setup](../integrations/drivers.md#configure-managed-credential-delivery)

Before selecting a model credential, confirm that its account policy allows the [OpenShell permission profile](../../reference/drivers/openshell-sandbox.md#codex-permission-profile).

## Prepare an existing OpenShell Gateway

The Kubernetes network helper defaults to `oce-system`. If you use an existing Gateway in another namespace, complete these steps before you start in the Console or call the API.

1. Confirm that the Installation references that Gateway. The command prints the Gateway endpoint, the Harness peer namespace and Service ClusterIP, and the namespaces in the workspace policies and RoleBinding. All must match that Gateway. OCE creates Agent and workspace NetworkPolicies from these fields.

   ```bash
   jq -r '(.backend[] | select(.type == "openshell") | .configuration.endpoint),
     (.drivers.compute.configuration.network.providerHarness | "\(.namespace) \(.address)"),
     (.drivers.sandbox.configuration.gateway | (.operatorWorkspaceResources + .networkPolicyResources)[]
       | .. | objects | .["kubernetes.io/metadata.name"] // (select(.kind == "ServiceAccount") | .namespace) // empty)' \
     "$INSTALLATION_FILE"
   ```

   Set `OPENSHELL_NAMESPACE` in the operator shell to the Gateway's namespace, if the installation did not already save it. The helper uses it for OpenShell Service discovery and policy placement. OCE stays in `oce-system`, and `save_session` retains the setting.

2. Confirm that the operator can read the Services used by the helper and manage NetworkPolicies in the affected namespaces.
3. Check that the API and worker Pods can reach the `openshell-gateway` Service on TCP 8080. The chart permits their outbound connections; the Gateway's ingress policy must admit them.
4. Ask the Gateway owner to check ingress for every existing client of the management Pods, including any ingress controller or proxy that connects to them. Verify that each required client has a scoped allow on its destination port before the helper applies its rules. On a cluster that enforces NetworkPolicy, the first ingress policy selecting those Pods can isolate them for ingress.

## 1. Select or register the model credential

Give the Agent and the resources created for it names that are unused in the Namespace.

```bash
name=fred
resource_prefix="$name-$(date +%s)"
```

If you already have a ready TokenService Source in this Namespace, set
`modelSource` to its ID and continue to [Agent creation](#2-create-the-configuration-and-agent).
Otherwise, use one of the methods below.

### Use a personally owned Codex login

The Console user who starts the login owns the resulting Source.

1. In the intended person's signed-in Console session, select the same Namespace
   as the operator session and open **Create Agent**. Name the Agent **fred**,
   choose dedicated Codex and **ChatGPT OAuth (Experimental)**, and select
   **Enable browser chat**. The checkbox is initially unchecked and requires
   [native browser setup](native-admin.md). Complete Codex sign-in and choose
   a [Codex model available to the account](../operate/model-verification.md#choose-a-model-for-dedicated-codex).
2. Select **Create Agent**. The saved draft opens. The deployer needs exact
   Source `operate` access. Native IAM grants missing Agent access at
   deployment; with another IAM Driver, grant it beforehand.
3. In the prepared operator shell, check the deployment's network prerequisites:

   ```bash
   deployment_preflight
   ```

4. In the Console draft, select **Deploy new version**. From the URL that opens,
   copy the Agent ID, the `revision` value, and the `namespace` value.
5. In the same operator shell, match the Namespace and wait for that submitted
   deployment:

   ```bash
   agent='<Agent ID from the Console URL>'
   revision='<revision from the Console URL>'
   test "$namespace" = '<namespace from the Console URL>' &&
     wait_deployment "$revision" &&
     modelSource=$(request GET "$base/agents/$agent/revisions/$revision" |
       jq -er '.data.harnessAuth | select(.method == "credential_source") | .sourceId')
   ```

   On Kubernetes and EKS, this applies the required Agent Service peer policies
   before checking deployment success. It does not submit another deployment.
   The saved Source ID supports the later Codex Apps procedure.
   Continue to [Control UI onboarding](#4-complete-onboarding-in-the-control-ui).

### Sign in with Codex OAuth

This operator shell authenticates as an OCC service principal. That principal
will own the Source, even if another person completes Codex sign-in. A different
person needs exact `credential_source:delete` permission to disconnect it.
For personal ownership, use the [Console procedure above](#use-a-personally-owned-codex-login).
Otherwise, start device login below. Open the returned
verification URL and enter the code there. Keep the code and saved response private.

```bash
device_login="$base/agents/device-authorizations"
request POST "$device_login" --data '{"harnessId":"codex"}' > "$RUN_DIR/device-login.json"
jq '.data | {verificationUrl, userCode, expiresAt, intervalSeconds}' "$RUN_DIR/device-login.json"
device_session=$(jq -er .data.session.id "$RUN_DIR/device-login.json")
```

After signing in, poll the same login. If the status is `pending`, wait the indicated interval before requesting another check.

```bash
request POST "$device_login/$device_session/poll" --data '{}' > "$RUN_DIR/device-login-status.json"
jq -r .data.status "$RUN_DIR/device-login-status.json"
```

When the status is `ready`, save the Source ID and continue.

```bash
modelSource=$(jq -er '.data | select(.status=="ready") | .source.id' "$RUN_DIR/device-login-status.json")
```

<a id="option-b-openai-api-key"></a>
<a id="select-or-register-the-source"></a>

### Use an OpenAI API key

Set `credential_file` to the path of your private API-key file. Send the value directly to TokenService through the Source API. The response contains Source metadata.

```bash
credential_file=/secure/oce/openai-api-key
jq -n --arg name "$resource_prefix-model" --rawfile key "$credential_file" \
  '{name:$name,type:"static",config:{provider_preset:"openai"},secret:($key|rtrimstr("\n"))}' |
  request POST "$base/credential-sources" --data-binary @- > "$RUN_DIR/model-source.json"
modelSource=$(jq -er '.data | select(.state=="ready") | .id' "$RUN_DIR/model-source.json")
```

<a id="option-a-chatgpt-service-account-token"></a>

For a Codex PAT, register the token through the same Source request with `config.provider_preset: "codex-pat"` and the token as the `secret` string. A live PAT turn remains unverified. [Verification record](https://github.com/openclaw/openclaw-enterprise/pull/7224)

<a id="create-and-deploy-fred-in-the-console"></a>

## 2. Create the Configuration and Agent

Use the Agent API to create a draft with the managed Source. Guided Create Agent with a managed Source returns `409`. Choose a [Codex model ID available to your credential](../operate/model-verification.md#choose-a-model-for-dedicated-codex), without the `codex/` prefix.

```bash
read -r -p "Codex model ID: " MODEL
```

<Snippet file="../../snippets/openshell-quickstart/codex-configuration.jq" lang="jq" />

The Configuration uses a fail-closed loopback URL. The OpenClaw Gateway reaches the dedicated Codex Harness through authenticated WebSocket transport.

```bash
jq -n --arg model "$MODEL" -f "$RUN_DIR/codex-configuration.jq" |
  request POST "$base/configurations" --data-binary @- > "$RUN_DIR/configuration"

jq -n --arg name "$name" --arg cfg "$(jq -er .data.id "$RUN_DIR/configuration")" \
  --arg m "$modelSource" '{
    name:$name,configurationId:$cfg,executionMode:"dedicated",gatewayManagedMode:true,
    harnessAuth:{method:"credential_source",sourceId:$m},credentialSources:[{sourceId:$m}]}' |
  request POST "$base/agents" --data-binary @- > "$RUN_DIR/agent"
agent=$(jq -er .data.id "$RUN_DIR/agent")
principal=$(jq -er .data.servicePrincipalId "$RUN_DIR/agent")
```

### Bind the origin before deployment

After creating the dedicated Agent, bind its exact browser origin to its new Configuration. Run these commands from the matching repository root. The hostname uses the same function as OCC. This example updates a new Configuration owned by this quickstart. For a shared or previously edited Configuration, follow the [per-Agent edit procedure](native-admin.md#configure-each-agent).

```bash
installation=$(request GET "/installation" | jq -er .data.id)
origin=$(node --input-type=module - "$CONSOLE_ORIGIN" "$NATIVE_ADMIN_DOMAIN" "$RUN_DIR/agent" "$installation" <<'JS'
import { readFileSync } from "node:fs";
import { deriveNativeAdminHost } from "./apps/controller/src/gateway/native-admin-host.ts";
const [consoleOrigin, nativeAdminDomain, agentFile, installation] = process.argv.slice(2);
const { data: agent } = JSON.parse(readFileSync(agentFile));
const url = new URL(consoleOrigin);
url.hostname = deriveNativeAdminHost(installation, agent, nativeAdminDomain);
console.log(url.origin);
JS
)
cfg=$(jq -er .data.id "$RUN_DIR/configuration")
request GET "$base/configurations/$cfg" |
  jq -e --arg origin "$origin" '.data | select(.generation==1) | {expectedGeneration:.generation,values} |
    .values.gateway += {publicOrigin:$origin,controlUi:{enabled:true,allowedOrigins:[$origin]}} |
    .values.gateway.auth += {mode:"trusted-proxy",
      trustedProxy:{userHeader:"x-occ-identity",allowUsers:["occ-workspace-files"],
        requiredHeaders:["x-openclaw-scopes"]},
      identityScopes:{"occ-workspace-files":["operator.admin"]}}' |
  request PATCH "$base/configurations/$cfg" --data-binary @- > "$RUN_DIR/browser-configuration"
```

## 3. Grant model access and deploy

Create one role scoped to credential sources. Bind that role to this Agent's principal for the model source only.

```bash
# POST $base/iam/roles: allow the operate action on CredentialSources.
role=$(jq -n --arg name "$resource_prefix-sources" \
  '{name:$name,permissions:[{action:"operate",resourceKind:"credential_source"}]}' |
  request POST "$base/iam/roles" --data-binary @- | jq -er .data.id)

# POST $base/iam/access-bindings: grant access to one exact source.
jq -n --arg p "$principal" --arg r "$role" --arg s "$modelSource" \
  '{subjectKind:"identity",subjectId:$p,roleId:$r,resourceKind:"credential_source",resourceId:$s}' |
  request POST "$base/iam/access-bindings" --data-binary @- > "$RUN_DIR/model-binding"

# Provision transport once, before the first revision.
request POST "$base/agents/$agent/runtime-credentials" --data '{}' > "$RUN_DIR/transport"
```

OCC derives the first-deployment network grants for Codex OAuth, Codex PAT,
and OpenAI API keys when the Installation ceiling permits the preset requests
for one stock Codex executable. See the exact requests for
[Codex OAuth](../../reference/credential-sources.md#codex-account-model-requests),
[Codex PAT](../../reference/credential-sources/managed-static.md#codex-pat),
and [OpenAI API keys](../../reference/credential-sources/managed-static.md#openai-api-key).

Deploy with the helper loaded during installation:

```bash
deploy_and_wait
```

Continue after the deployment reports `succeeded` and the Agent's `activeRevisionId` matches it. If the Console says the model is unavailable, see [Recover from an unavailable model](../topics/agent-troubleshoot.md#the-configured-model-is-unavailable).

<a id="7-verify-a-turn-through-openclaw"></a>

## 4. Complete onboarding in the Control UI

<AccordionGroup>
<Accordion title="Control UI">

<Snippet file="../../snippets/openshell-quickstart/console-open-agent.md" />

In the Control UI, send this message:

> Your name is fred. I prefer short answers. Please finish onboarding and save those details.

In the Console, open **Workspace files** on `fred`. Check `IDENTITY.md` for its name and `USER.md` for your preference.

Send `Reply with OCE_READY.` and confirm the reply. Close the Agent tab, reopen **Open Agent UI**, and select the **same conversation** in chat history. Ask “How do I like my answers?” and check the reply against your saved preference. Retain the conversation's browser path with the private session record.

To hand off work, share the Namespace, Agent name, conversation label, and a link to the decision in your team’s repository at the exact commit. Keep launch tokens, redemption tokens, and browser cookies private. Your teammate signs in to the Console with their own account and [opens the Agent](native-admin.md#local-development). If they see the conversation in chat history, they can select it. Otherwise, they can start a new conversation with the decision reference.

<Snippet file="../../snippets/openshell-quickstart/console-onboard.md" />

</Accordion>
<Accordion title="CLI">

To check that the deployed Agent can answer through its Gateway, run this in the same operator shell:

```bash
printf '%s\n' 'Reply with OCE_READY.' > "$RUN_DIR/setup-prompt"
turn "$RUN_DIR/setup-prompt" > "$RUN_DIR/setup-result" &&
  jq -e '.outcome.status == "ok" and (.outcome.terminalReply.text | contains("OCE_READY"))' "$RUN_DIR/setup-result"
```

A successful check prints `true`. Each `turn` starts a new conversation. Use the Control UI steps to complete onboarding and verify recall in the same conversation.

</Accordion>
</AccordionGroup>

<a id="keep-the-session-for-the-next-stage"></a>
<a id="check-gateway-egress-before-adding-git"></a>

## Resume the operator session

```bash
save_session
```

Run the two commands printed by `save_session` to resume the private operator session in a fresh Bash shell. The service key stays in its protected file. Keep the Agent running. To extend it, follow [Configure GitHub repository access](../repository-credentials.md#set-github-app-access-for-an-openshell-agent) or [Add Codex apps](../integrations/codex-plugins.md).

## Clean up a separately managed Gateway

Follow the [Agent deletion procedure](quickstart-delete-agent.md) first. Keep the separately managed OpenShell release. Skip the `helm uninstall openshell-gateway` step in the installation cleanup.

Resume the saved session for each run directory used by this installation. Review the helper's policy manifests in `$RUN_DIR` and confirm ownership. Check that workloads you are retaining have the rules they need. Then delete the recorded policies.

```bash
delete_service_peers
```

The helper deletes by manifest in each recorded namespace. This includes the management policies in the saved `OPENSHELL_NAMESPACE`. Retain the run directory until cleanup is complete.

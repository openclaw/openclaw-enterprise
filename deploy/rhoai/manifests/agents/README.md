# Deploy the first OpenShift Agent

Deploy one dedicated Codex Agent on the OpenShift cluster after OCC is installed
and private Agent routing is enabled. The Agent uses the OpenShell runtime
provider; ServicePrincipal credentials stay disabled because OpenShell cannot
project the Agent identity.

Run from the repository root with the private kubeconfig and the variables from
the installation.

## Select the tenant

The OCC Namespace ID and the Kubernetes tenant namespace are different values.

```bash
umask 077
export OCC_INPUT_DIRECTORY="$HOME/.local/state/openclaw-enterprise/rhoai"
export KUBECONFIG="$OCC_INPUT_DIRECTORY/kubeconfig"
export OCC_URL="https://$OCC_CONSOLE_HOST"
export OCC_SERVICE_KEY_FILE="$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"

export OCC_NAMESPACE="$(deploy/rhoai/bin/occ namespace list -o json |
  jq -r '.[] | select(.name == "default") | .id')"
export TENANT_NAMESPACE="$(oc get namespaces \
  -l "openclaw.dev/namespace=$OCC_NAMESPACE" -o json |
  jq -er '.items | if length == 1 then .[0].metadata.name
    else error("expected one tenant namespace") end')"
export GATEWAY_NAMESPACE="$TENANT_NAMESPACE"

deploy/rhoai/bin/occ namespace get "$OCC_NAMESPACE"
```

Expect the Namespace to be `ready`. Attach the tenant to the private Gateway;
the Envoy NetworkPolicy admits supervisor Pods only from attached namespaces,
and the workspace node cannot pair without this label.

```bash
oc get namespace "$TENANT_NAMESPACE" -o json |
  jq -e --arg id "$OCC_NAMESPACE" '
    .metadata.labels["openclaw.dev/namespace"] == $id and
    .metadata.annotations["openclaw.dev/namespace-id"] == $id'

export ROUTING_LABEL="$(oc -n openclaw-system get gateway oce-agent-gateways -o json |
  jq -er '.spec.listeners[] | select(.name == "https") |
    .allowedRoutes.namespaces.selector.matchLabels["openclaw-enterprise.io/gateway"]')"
oc label namespace "$TENANT_NAMESPACE" \
  "openclaw-enterprise.io/gateway=$ROUTING_LABEL" --overwrite
```

## Register the model credential

Use an OpenAI API key authorized for the model in the Agent Configuration. OCC
stores the value in a managed Secret in the tenant namespace, and the Credential
Gateway stores a copy in OpenShell. Keep the key out of shell history, command
arguments, and repository files.

```bash
umask 077
read -r -s -p 'OpenAI API key: ' OPENAI_API_KEY
printf '\n'
printf '%s' "$OPENAI_API_KEY" |
  jq -Rs '{name: "openai-model-key", value: .}' \
  > "$OCC_INPUT_DIRECTORY/model-secret.json"
unset OPENAI_API_KEY

export SECRET_REF="$(deploy/rhoai/bin/occ secret create \
  --file "$OCC_INPUT_DIRECTORY/model-secret.json" -o json | jq -c .ref)"
rm -f "$OCC_INPUT_DIRECTORY/model-secret.json"
test -n "$SECRET_REF" && test "$SECRET_REF" != null

jq -n --argjson ref "$SECRET_REF" \
  '{name: "openai", type: "openai", secrets: {api_key: $ref}}' \
  > "$OCC_INPUT_DIRECTORY/credential-source.json"
export SOURCE_ID="$(deploy/rhoai/bin/occ credential-source create \
  --file "$OCC_INPUT_DIRECTORY/credential-source.json" -o json | jq -r .id)"
deploy/rhoai/bin/occ credential-source get "$SOURCE_ID"
```

Expect `STATE` and `GATEWAY STATUS` to be `ready`. OCC does not update OpenShell
automatically when the underlying Secret changes; rotate the source explicitly.

Omit the `modelProvider` object to use the standard OpenAI endpoint. For a
custom OpenAI-compatible endpoint, set the Installation provider and authorize
the same base URL. The credential source's `config.authorized_base_url` must
match this base URL exactly.

```yaml
drivers.compute.configuration.runtime.modelProvider:
  protocol: openai-responses
  baseUrl: https://models.example.com/v1
```

Apply the change to the Installation startup Secret and restart the API and
worker before deploying the Agent. Without it, deployment rejects the credential
source because its authorized destination does not match the revision provider.

## Create the Configuration and Agent

The dedicated Codex Configuration selects `codex/gpt-6-luna` with a fail-closed
provider URL. The authenticated Codex process reaches the model through
OpenShell. Do not put the API key in the Configuration.

```bash
export CONFIGURATION_FILE=deploy/rhoai/manifests/openshift/codex-luna-configuration.json
# REQUIRED: display name for this Agent and its OpenClaw assistant.
export AGENT_NAME='<Agent display name>'

jq --arg name "$AGENT_NAME" \
  '.values.agents.entries.main.name = $name |
   .values.agents.entries.main.identity.name = $name' \
  "$CONFIGURATION_FILE" > "$OCC_INPUT_DIRECTORY/named-configuration.json"
export CONFIGURATION_ID="$(deploy/rhoai/bin/occ configuration create \
  --file "$OCC_INPUT_DIRECTORY/named-configuration.json" -o json | jq -r .id)"

jq -n --arg name "$AGENT_NAME" --arg configuration "$CONFIGURATION_ID" \
  --arg source "$SOURCE_ID" \
  '{name: $name, configurationId: $configuration,
    executionMode: "dedicated",
    harnessAuth: {method: "credential_source", sourceId: $source},
    credentialSources: [{sourceId: $source}]}' \
  > "$OCC_INPUT_DIRECTORY/agent.json"
deploy/rhoai/bin/occ agent create --file "$OCC_INPUT_DIRECTORY/agent.json" -o json \
  > "$OCC_INPUT_DIRECTORY/agent-response.json"

export AGENT_ID="$(jq -r .id "$OCC_INPUT_DIRECTORY/agent-response.json")"
export AGENT_PRINCIPAL="$(jq -r .servicePrincipalId \
  "$OCC_INPUT_DIRECTORY/agent-response.json")"
export AGENT_SA="agent-$(printf '%s' "$AGENT_ID" | sha256sum |
  awk '{print substr($1, 1, 12)}')"
export GATEWAY_SA="gateway-${AGENT_SA#agent-}"
printf 'Agent ID: %s\nAgent ServiceAccount: %s\nGateway ServiceAccount: %s\n' \
  "$AGENT_ID" "$AGENT_SA" "$GATEWAY_SA"
```

Grant the Agent service principal `operate` on the exact credential source, not
on the whole Namespace.

```bash
jq -n '{name: "Use an OpenShell credential source",
  permissions: [{action: "operate", resourceKind: "credential_source"}]}' \
  > "$OCC_INPUT_DIRECTORY/credential-source-role.json"
export ROLE_ID="$(deploy/rhoai/bin/occ iam role create \
  --file "$OCC_INPUT_DIRECTORY/credential-source-role.json" -o json | jq -r .id)"

jq -n --arg principal "$AGENT_PRINCIPAL" --arg role "$ROLE_ID" \
  --arg source "$SOURCE_ID" \
  '{subjectKind: "identity", subjectId: $principal, roleId: $role,
    resourceKind: "credential_source", resourceId: $source}' \
  > "$OCC_INPUT_DIRECTORY/credential-source-binding.json"
deploy/rhoai/bin/occ iam access-binding create \
  --file "$OCC_INPUT_DIRECTORY/credential-source-binding.json"
```

Allow the Agent Gateway and sandbox identities to pull the runtime image. The
published runtime comes from public `quay.io`, so this grant is unused today;
apply it anyway so a future in-cluster build keeps working.

```bash
oc -n openclaw-system create rolebinding "oce-runtime-pull-${AGENT_SA#agent-}" \
  --clusterrole=system:image-puller \
  --serviceaccount="$GATEWAY_NAMESPACE:$GATEWAY_SA" \
  --serviceaccount="$TENANT_NAMESPACE:openshell-sandbox" \
  --dry-run=client -o yaml | oc apply -f -
```

## Admit the Agent Gateway

The Agent Gateway runs as UID/GID 1000 in the tenant namespace. Grant its exact
ServiceAccount use of the existing `oce-fixed-uid-1000` SCC before requesting a
revision. Without it, OpenShift rejects the Gateway Pod and its
`WaitForFirstConsumer` PVC stays pending.

```bash
oc -n "$GATEWAY_NAMESPACE" create role oce-fixed-uid-1000-agent-gateway \
  --verb=use --resource=securitycontextconstraints.security.openshift.io \
  --resource-name=oce-fixed-uid-1000 \
  --dry-run=client -o yaml | oc apply -f -
oc -n "$GATEWAY_NAMESPACE" create rolebinding oce-fixed-uid-1000-agent-gateway \
  --role=oce-fixed-uid-1000-agent-gateway \
  --serviceaccount="$GATEWAY_NAMESPACE:$GATEWAY_SA" \
  --dry-run=client -o yaml | oc apply -f -
oc auth can-i use scc/oce-fixed-uid-1000 -n "$GATEWAY_NAMESPACE" \
  --as="system:serviceaccount:$GATEWAY_NAMESPACE:$GATEWAY_SA"
```

Expect `yes`. The provider Harness keeps the workspace chart's
`openshell-sandbox` ServiceAccount under `restricted-v2`; do not replace it with
the Agent ServiceAccount.

## Deploy and verify

```bash
deploy/rhoai/bin/occ agent deploy "$AGENT_ID"
```

Record the returned revision ID, then check its status and pairing evidence:

```bash
export DEPLOYMENT_ID='<revision ID returned by deploy>'
deploy/rhoai/bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID"
oc -n "$TENANT_NAMESPACE" get secrets -o json |
  jq -e --arg prefix "workspace-node-${AGENT_SA#agent-}-" \
    '[.items[] | select(.metadata.name | startswith($prefix)) |
      select(.data.deviceId != null)] | length == 1'
```

Wait for `succeeded`; the `jq` check prints `true`. These results prove
deployment and pairing, not a model turn. Continue with the
[Control UI Route](../openshift/README.md#control-ui-route) and complete a real
model turn.

## Size native worker capacity for subagents

A dedicated native Agent runs its session turns as worker environments on the
Agent's Sandbox node, and every subagent the Agent spawns takes another one.
The node refuses additional sessions at capacity. The limit is
`runtime.nativeOpenClawSessionCapacity` in the Installation (default `8`,
range `1`-`1024`); a Sandbox picks up a changed value only after a redeploy.
Idle workers are not retired automatically, and an Agent orchestrating
parallel subagents also occupies a slot for its own turn, so size the limit
to the Agent's peak subagent concurrency plus one. Agents that only answer
chats never need more than the default.

## Add initial Agent files

Open the Agent's **Workspace files** tab in OCC. Bootstrap may already provide
`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`. Create only missing files
and edit existing instructions deliberately. Verify the Agent can read them from
`/sandbox/enterprise` during a model turn.

# Use a credential source on the local OpenShell profile

Use this procedure to register an OpenAI API key with the OpenShell Credential
Gateway and bind it to a dedicated Codex Agent on the
[local OpenShell profile](local-kubernetes-development.md#start-the-openshell-fail-closed-profile).
OpenShell keeps its own copy of the key and substitutes it on requests to
`api.openai.com`; the Harness receives only a placeholder. The
[credential source reference](../../reference/credential-sources.md) defines the
API behavior.

Stock OpenShell `v0.1.0` still rejects the Agent's app-server token projection,
so the deployment in this profile fails closed before a Sandbox starts. The
procedure proves registration, authorization, and admission. For a real model
turn with the injected key, run the
[OpenShell compatibility proof](../../testing/openshell.md#openshell-sandbox).

## Before you start

Start the Kubernetes-only OpenShell profile and build the CLI:

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

Export the API URL and service-key file that `dev-up` printed, then select the
bootstrap Namespace:

```bash
export OCC_URL='<API URL printed by scripts/dev-up>'
export OCC_SERVICE_KEY_FILE='<Service key file printed by scripts/dev-up>'
export OCC_NAMESPACE="$(./bin/occ namespace list -o json |
  jq -r '.[] | select(.name == "default") | .id')"
```

You need an existing OpenAI API key in a private file, `jq`, and a model name
that key can use.

## Register the key

Store the key as a Namespace Secret. Build the request file with owner-only
permissions, delete it after use, and never put the key on the command line:

```bash
(umask 077; tr -d '\n' < /path/to/openai-key |
  jq -Rs '{name: "openai-model-key", value: .}' > model-secret.json)
SECRET_REF="$(./bin/occ secret create --file model-secret.json -o json | jq -c .ref)"
rm model-secret.json
```

Register the Secret as an `openai` credential source:

```bash
jq -n --argjson ref "$SECRET_REF" \
  '{name: "openai", type: "openai", secrets: {api_key: $ref}}' > credential-source.json
SOURCE_ID="$(./bin/occ credential-source create --file credential-source.json -o json |
  jq -r .id)"
./bin/occ credential-source get "$SOURCE_ID"
```

Expected result: `STATE` and `GATEWAY STATUS` both show `ready`. The response
never contains the key. Changing the Secret afterward does not change the
gateway's copy.

## Create the Agent and grant the source

Write a dedicated Codex Configuration. Replace `<model>` in both places:

```bash
cat > configuration.json <<'JSON'
{
  "kind": "agent",
  "values": {
    "gateway": {
      "mode": "local",
      "bind": "lan",
      "controlUi": { "enabled": false },
      "auth": {
        "password": { "source": "env", "provider": "default", "id": "OPENCLAW_GATEWAY_PASSWORD" }
      },
      "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
    },
    "agents": {
      "defaults": {
        "model": "codex/<model>",
        "models": { "codex/<model>": { "agentRuntime": { "id": "codex" } } }
      }
    },
    "models": {
      "providers": {
        "codex": {
          "baseUrl": "http://127.0.0.1:9",
          "api": "openai-responses",
          "models": [{ "id": "<model>", "name": "<model>" }]
        }
      }
    },
    "plugins": {
      "allow": ["codex"],
      "entries": {
        "codex": {
          "enabled": true,
          "config": {
            "appServer": {
              "mode": "guardian",
              "approvalPolicy": "on-request",
              "sandbox": "read-only",
              "transport": "websocket",
              "url": "${APP_SERVER_URL}",
              "authToken": "${APP_SERVER_TOKEN}"
            }
          }
        }
      }
    }
  }
}
JSON
CONFIGURATION_ID="$(./bin/occ configuration create --file configuration.json -o json | jq -r .id)"
```

Create the Agent with the source as its Harness authentication:

```bash
jq -n --arg configuration "$CONFIGURATION_ID" --arg source "$SOURCE_ID" \
  '{name: "openshell-codex", configurationId: $configuration, executionMode: "dedicated",
    harnessAuth: {method: "credential_source", sourceId: $source}}' > agent.json
./bin/occ agent create --file agent.json -o json > agent-response.json
AGENT_ID="$(jq -r .id agent-response.json)"
```

Deployment requires the Agent's service principal to have `operate` on the
exact source. It needs no permission on the Secret:

```bash
jq -n '{name: "Use a credential source",
  permissions: [{action: "operate", resourceKind: "credential_source"}]}' > role.json
ROLE_ID="$(./bin/occ iam role create --file role.json -o json | jq -r .id)"
jq -n --arg principal "$(jq -r .servicePrincipalId agent-response.json)" \
  --arg role "$ROLE_ID" --arg source "$SOURCE_ID" \
  '{subjectKind: "identity", subjectId: $principal, roleId: $role,
    resourceKind: "credential_source", resourceId: $source}' > binding.json
./bin/occ iam access-binding create --file binding.json
```

## Deploy and check the result

```bash
DEPLOYMENT_ID="$(./bin/occ agent deploy "$AGENT_ID" -o json | jq -r .id)"
./bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID"
```

Expected result: OCC accepts the deployment and freezes
`{"method": "credential_source", "sourceId": "cs_…"}` in the revision. The
status then reaches `failed` with `DEPENDENCY_UNAVAILABLE`, because stock
OpenShell cannot project the app-server token. No Sandbox is created, and the
Agent's `oce-*` Harness namespace contains no Secret. Without the access
binding, the deploy request fails with `403`.

## Clean up

A source cannot be deleted while an Agent references it. Delete the Agent first,
wait until `agent get` returns `404`, then delete the source and its Secret:

```bash
./bin/occ agent delete "$AGENT_ID"
./bin/occ credential-source delete "$SOURCE_ID"
./bin/occ secret delete "$(jq -r .secrets.api_key.id credential-source.json)"
```

Deleting the source also removes the gateway's copy. Within about a minute of
registration, `credential-source delete` returns `503` and keeps the source as
`deleting`; run it again after that window. To discard the whole
environment, [stop and clean up](local-kubernetes-development.md#stop-and-clean-up)
the profile instead.

## Troubleshoot

- **`credential-source create` returns `503`:** the API cannot reach OpenShell
  Gateway, or no Credential Gateway is selected. Check that `dev-up` finished
  and that the `openshell-gateway` Pod in `oce-system` is running.
- **A source stays `registering` or `deleting`:** a registration was
  interrupted or its cleanup failed. Run `./bin/occ credential-source delete`
  to remove any gateway copy; retry it until it succeeds.
- **`GATEWAY STATUS` is not `ready`:** read the `reason` from
  `./bin/occ credential-source get "$SOURCE_ID" -o json`.
- **Deploy returns `409`:** the Agent uses `api_key` or another Secret-backed
  method. With a Credential Gateway selected, only `credential_source` is
  accepted.
- **`credential-source delete` returns `409`:** an Agent draft, active
  revision, or pending deployment still references the source.

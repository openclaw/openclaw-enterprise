# Use a credential source on the local OpenShell profile

Use this procedure to register an OpenAI-compatible API key with the OpenShell Credential
Gateway and bind it to a dedicated Codex Agent on the
[local OpenShell profile](local-kubernetes-development.md#start-the-openshell-fail-closed-profile).
OpenShell keeps its own copy of the key and substitutes it only on requests to
the source endpoint; the Harness receives only a placeholder. By default the
endpoint is `https://api.openai.com/v1`. The
[credential source reference](../../reference/credential-sources.md) defines the
API behavior.

The profile installs private Gateway routing, so the deployment provisions an
OpenShell Sandbox for the dedicated Codex Harness. To run these steps and verify
a real model turn with the injected key in one command, use
[Deploy your first Agent](../first-agent.md) with `--harness codex`.

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

You need an existing provider API key in a private file, `jq`, and a model name
that key can use. Register the complete native model ID under
`models.providers.codex`, including any namespace. OCE's generated Gateway
configuration supplies the native provider explicitly; do not add it to the
model ID yourself.

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

For an OpenAI-compatible service, set `OPENAI_BASE_URL` to its HTTPS `/v1`
endpoint before creating the source. Codex requires Responses API compatibility,
including streaming. The credential source selects Codex's endpoint; keep
`models.providers.codex.baseUrl` at the fail-closed `http://127.0.0.1:9` shown
below. The Gateway must not make direct model requests.
For an endpoint requiring a raw `x-api-key` header, also set
`OPENAI_AUTH_HEADER=x-api-key`. Otherwise omit it for Bearer authentication.
Only the selector belongs in source configuration; the key remains in the Secret.

```bash
jq -n --argjson ref "$SECRET_REF" --arg base_url "${OPENAI_BASE_URL:-}" \
  --arg auth_header "${OPENAI_AUTH_HEADER:-authorization}" \
  '{name: "openai", type: "openai", config: ({auth_header: $auth_header} + (if $base_url == "" then {} else {base_url: $base_url} end)), secrets: {api_key: $ref}}' > credential-source.json
SOURCE_ID="$(./bin/occ credential-source create --file credential-source.json -o json |
  jq -r .id)"
./bin/occ credential-source get "$SOURCE_ID"
```

Expected result: `STATE` and `GATEWAY STATUS` both show `ready`. The response
never contains the key. Changing the Secret afterward does not change the
gateway's copy.

## Create the Agent and grant the source

Write a dedicated Codex Configuration. Replace each `<model>` with the native
model ID, such as `gpt-5.6-luna`:

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

The Configuration keeps `"sandbox": "read-only"`, but each deployed revision
freezes `"sandbox": "danger-full-access"`. The OpenShell Sandbox Driver
overrides this value for every dedicated Codex revision so that Codex's own
sandbox does not run inside OpenShell's; OpenShell is the containment boundary.
See [OpenShell Sandbox configuration](../../reference/drivers/openshell-sandbox.md#configuration).

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
`{"method": "credential_source", "sourceId": "cs_…"}` in the revision. Compute
starts the Agent Gateway, then OpenShell creates the Sandbox, and the revision
becomes active once the Harness workspace node connects to the Gateway. Startup
can take several minutes. Without the access binding, the deploy request fails
with `403`.

## Rotate the key

Changing the Secret does not change the gateway's copy. Update the Secret, or
create a replacement, and then push it to the gateway:

```bash
./bin/occ credential-source update "$SOURCE_ID"
```

For a replacement Secret, add `--file` with
`{"secrets": {"api_key": <replacement ref>}}`. Running Agents keep the old value
until they are redeployed. The
[update reference](../../reference/credential-sources.md#update-a-source) lists the
required permissions and failure cases.

## Clean up

A source cannot be deleted while an Agent references it. Record the source's
current Secret, delete the Agent, and wait until `agent get` returns `404`:

```bash
SECRET_ID="$(./bin/occ credential-source get "$SOURCE_ID" -o json | jq -r .secrets.api_key.id)"
./bin/occ agent delete "$AGENT_ID"
./bin/occ agent get "$AGENT_ID"
```

Then delete the source, its Secret, the Configuration, and the Role:

```bash
./bin/occ credential-source delete "$SOURCE_ID"
./bin/occ secret delete "$SECRET_ID"
./bin/occ configuration delete "$CONFIGURATION_ID"
./bin/occ iam role delete "$ROLE_ID"
rm -f credential-source.json configuration.json agent.json agent-response.json role.json binding.json
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
  revision, or pending deployment still references the source. With
  `CREDENTIAL_WITHDRAWAL_IN_PROGRESS`, only withdrawal work still retrying for
  an earlier revision that held the source blocks it: wait up to about an hour,
  or delete the Agent.
- **`iam role delete` returns `409`:** an access binding still uses the Role.
  Deleting the source removes its bindings; otherwise find the binding with
  `./bin/occ iam access-binding list` and delete it first.

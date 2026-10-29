# Deploy your first Agent

Create your own Agent in the Kubernetes installation from [Local setup](quickstart.md),
deploy it, and get a real response from an OpenAI model. You choose the Agent
name and supply an OpenAI API key or, for dedicated Codex with OpenShell, a personal access token. The Agent stays in your installation
after the command exits.

## Before you start

- Complete [Local setup](quickstart.md) and leave the installation running.
- Select either `OCC_DEVELOPMENT_SANDBOX_DRIVER=none` for the default embedded
  OpenClaw Agent or `openshell` for the experimental dedicated Codex path.
- For the default path, leave about 2.5 GiB of cluster memory free: the Agent's
  Gateway Pod requests `2560Mi` ([sizing](deploy/installation-profiles.md)).
- Use the same checkout and development state directory. If you set
  `OCC_DEVELOPMENT_STATE_DIRECTORY` during setup, use the same value here.
  The command uses the recorded local container-engine socket and ignores
  Docker TLS settings inherited from your terminal.
- Have an OpenAI API key that can use [`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra), the default model. To use a
  different model available to your project, set `OPENCLAW_FIRST_AGENT_MODEL`
  to its plain ID, without `openai/`.
- Keep the key out of commands, Configuration JSON, and chat. For automation,
  set `OPENAI_API_KEY_FILE` to a private file containing the key, or supply
  `OPENAI_API_KEY` through your environment's secret manager; setting both
  fails. The command prompts for the key without echoing it only when neither
  is set. An exported key is used as is, so clear a stale one with
  `env -u OPENAI_API_KEY` to be prompted instead.

For dedicated Codex with OpenShell, a personal access token (including a service-account token)
can replace the API key. Supply `CODEX_ACCESS_TOKEN` through your secret manager
or set `CODEX_ACCESS_TOKEN_FILE` to its private file. Select one credential input;
do not also set an API-key input. The helper records the authentication method
for later reuse and credential replacement.

The walkthrough runs from the repository root on your own development
installation. If you followed [Kubernetes Setup](kubernetes-setup.md) on an
existing cluster, use [Deploy and verify production Agents](deploy/production-agents.md).

## Steps

<span id="1-sign-in-and-choose-your-namespace"></span>
<span id="1.-sign-in-and-choose-your-namespace"></span>

### 1. Check that the Namespace is ready

In the terminal where you set the OCC URL and service-key file during
[Local setup](quickstart.md#read-the-installation-with-the-bootstrap-service-key), run:

```bash
./bin/occ namespace list
```

Wait until `default` shows `ready`. This is where the command will create your
Agent.

<span id="2-create-the-agent"></span>
<span id="2.-create-the-agent"></span>
<span id="3-save-credentials-and-request-deployment"></span>
<span id="3.-save-credentials-and-request-deployment"></span>

### 2. Create and deploy your Agent

Choose a name for your Agent; this example uses `my-agent`:

```bash
node scripts/first-agent.mjs my-agent --prompt 'What is 2 + 2?'
```

Enter the OpenAI API key when prompted. The command stores it in a platform
Secret, creates the named Agent with the Embedded OpenClaw Harness, grants that
Agent access to its Secret, and requests the first deployment. It then waits
for the gateway and sends a verification prompt before sending your own. Initial
startup can take several minutes.

This starter answers model prompts only, and tools remain disabled. Native
admin UI is disabled unless you select the supported local option below. The
command refuses to reuse the Agent if you change its Configuration elsewhere.
For other policy changes, create a separate console-managed Agent; see
[Agent Configuration](../reference/configuration.md) and
[Plugins](../reference/agent-plugins.md).

If Local setup selected OpenShell, add `--harness codex`:

```bash
node scripts/first-agent.mjs my-agent --harness codex --prompt 'What is 2 + 2?'
```

That path stores the credential in a platform Secret and registers an `openai`
API-key source or a `codex-pat` token source. It grants the Agent access to the source—not the Secret. It
uses OpenShell's experimental provider-file and bearer-passthrough APIs, so it
is a development workflow rather than production qualification. Reuse the same
`--harness` selection with that Agent name.

When Local setup runs OCC in Compose with both Kubernetes Compute and OpenShell,
you can also expose this Agent's native Control UI through OCC:

```bash
node scripts/first-agent.mjs my-agent --harness codex --control-ui --prompt 'What is 2 + 2?'
```

Use a new Agent name when adding or removing `--control-ui`; the choice is part
of the helper-owned Agent record. The helper creates the Agent first, derives
its exact HTTPS origin, and saves a second Configuration generation with that
origin in `controlUi.allowedOrigins`. It also configures native trusted-proxy
authentication for the OCC identity. The allowed origin is required: do not
replace it with the console origin or a wildcard.

Keep the command running until it prints `Model response verified:` followed by
the phrase it asked the model to repeat. Under `Agent response:`, it then prints
the model's answer to your question. It also prints the Agent ID, active
version, and console URL. With `--control-ui`, it also prints the Control UI
URL. These returned responses complete the model check; see
[what each check establishes](operate/model-verification.md#what-each-check-establishes).

<span id="4-check-what-actually-deployed"></span>
<span id="4.-check-what-actually-deployed"></span>

### 3. Find your Agent in the console

Open the console link from the command and sign in with the local credentials
from [Local setup](quickstart.md#open-the-platform-console). **Current version**
shows the version selected by OCC; **Deployment activity** shows persisted
deployment progress. Use the terminal command for further model prompts. For
browser access to the Agent's files, follow
[workspace verification](deploy/workspace-routing.md#verify-routing-and-file-access).

For `--control-ui`, first trust the browser CA certificate printed by Local
setup, sign in at the HTTPS console link, and then open the printed Control UI
link. Both hosts are installation-specific `.localhost` names on the same
loopback-only HTTPS port. Native edits are Pod-local; keep durable changes in
the OCE Configuration.

The Agent remains available after the command exits. Run the same command with
the same Agent name and a different `--prompt` to ask another question; you do
not need to enter the model key again. Stopping the local stack
with `dev down` [deletes the installation and its Agents](quickstart.md#clean-up-and-stop).

## Clean up

To remove only this Agent and keep the installation, use its local helper record
as the ownership record. Do not run the helper or edit this Agent or its credential
source during cleanup. Select the `first-agent-*.json` for the name you used in the
Local setup state directory (`OCC_DEVELOPMENT_STATE_DIRECTORY` when set; otherwise
`openclaw-development` inside Node.js's `os.tmpdir()`). The filename uses the first
32 hexadecimal characters of SHA-256 of the Agent name. Do not print the record or
credential files.

Set `OCC_NAMESPACE` to the `default` Namespace ID and `AGENT_ID` to the ID printed by
the helper (or find it with `./bin/occ agent list`). Select the exact record path:

```bash
export OCC_NAMESPACE='<default-namespace-id>'
export AGENT_ID='<agent-id>'
export FIRST_AGENT_RECORD='<local-state-directory>/first-agent-<name-hash>.json'
```

Run this whole block in Bash. It checks the recorded Namespace, Agent,
Configuration, credential source and original Secret before any deletion. Missing
records, unsupported Sandbox Driver/authentication pairs, failed lookups or changed
references stop cleanup; they never fall back
to deleting whichever Secret is referenced now. For a missing record or drift,
leave resources in place and establish ownership manually before removing them.
A name prefix alone is not ownership evidence.

```bash
(
  set -euo pipefail
  RECORD="$(jq -ec --arg ns "$OCC_NAMESPACE" --arg agent "$AGENT_ID" '
    select(.version == 3 and .namespaceId == $ns and .agentId == $agent)
    | select((.sandboxDriver == "none" and .authMethod == "api_key") or
        (.sandboxDriver == "openshell" and
          (.authMethod == "api_key" or .authMethod == "codex_pat")))
    | select(.configurationId | type == "string" and startswith("cfg_"))
    | select(.secretId | type == "string" and startswith("sec_"))
    | {namespaceId, agentId, configurationId, secretId, credentialSourceId,
       sandboxDriver, authMethod}
  ' "$FIRST_AGENT_RECORD")"
  CONFIGURATION_ID="$(jq -er .configurationId <<<"$RECORD")"
  SECRET_ID="$(jq -er .secretId <<<"$RECORD")"
  AGENT_JSON="$(./bin/occ agent get "$AGENT_ID" -o json)"
  jq -e --arg id "$CONFIGURATION_ID" '.configurationId == $id' \
    <<<"$AGENT_JSON" >/dev/null
  SOURCE_ID=''
  if [[ "$(jq -r .sandboxDriver <<<"$RECORD")" == openshell ]]; then
    SOURCE_ID="$(jq -er '.credentialSourceId | select(startswith("cs_"))' <<<"$RECORD")"
    jq -e --arg id "$SOURCE_ID" \
      '.harnessAuth == {method:"credential_source", sourceId:$id}' \
      <<<"$AGENT_JSON" >/dev/null
    SOURCE_JSON="$(./bin/occ credential-source get "$SOURCE_ID" -o json)"
    FIELD="$(jq -er '.authMethod | if . == "codex_pat" then "access_token"
      elif . == "api_key" then "api_key" else error("unknown credential method") end' <<<"$RECORD")"
    jq -e --arg field "$FIELD" --arg ns "$OCC_NAMESPACE" --arg id "$SECRET_ID" \
      '.secrets == {($field):{kind:"secret", namespaceId:$ns, id:$id}}' \
      <<<"$SOURCE_JSON" >/dev/null
    ROLE_NAME="$(node --input-type=module - "$AGENT_ID" "$SOURCE_ID" <<'JS'
import { createHash } from 'node:crypto';
const suffix = createHash('sha256').update(process.argv[2]).update('\0')
  .update(process.argv[3]).digest('hex').slice(0, 16);
console.log(`Local first Agent source ${suffix}`);
JS
)"
    ROLE_ID="$(./bin/occ iam role list -o json |
      jq -er --arg name "$ROLE_NAME" '.[] | select(.name == $name) | .id')"
  else
    jq -e --arg ns "$OCC_NAMESPACE" --arg id "$SECRET_ID" \
      '.harnessAuth == {method:"api_key", source:{kind:"secret", namespaceId:$ns, id:$id}}' \
      <<<"$AGENT_JSON" >/dev/null
    ROLE_ID="$(node --input-type=module - "$AGENT_ID" "$SECRET_ID" <<'JS'
import { createHash } from 'node:crypto';
const suffix = createHash('sha256').update(process.argv[2]).update('\0')
  .update(process.argv[3]).digest('hex');
console.log(`role_local_first_agent_secret_${suffix}`);
JS
)"
  fi
  ./bin/occ agent delete "$AGENT_ID"
  gone=false
  for attempt in {1..60}; do
    if result="$(./bin/occ agent get "$AGENT_ID" -o json 2>&1)"; then
      sleep 2
    elif [[ "$result" == 'Error: OCC operation failed (HTTP 404): NOT_FOUND: '* ]]; then
      gone=true
      break
    else
      printf '%s\n' "$result" >&2
      exit 1
    fi
  done
  [[ "$gone" == true ]]
  if [[ -n "$SOURCE_ID" ]]; then
    ./bin/occ credential-source delete "$SOURCE_ID"
  fi
  ./bin/occ configuration delete "$CONFIGURATION_ID"
  ./bin/occ secret delete "$SECRET_ID"
  ./bin/occ iam role delete "$ROLE_ID"
)
```

An in-place key rotation keeps the same Secret reference and passes the guard.
Replacing the reference stops before any DELETE, even if the replacement Secret
has no other consumers. Reads return references, never credential values.

If deletion stops after removing the Agent, inspect the error and remaining
resources manually; the block requires an existing Agent for its ownership checks.
Source deletion can return `409` while references remain, or `503` after a gateway
failure or during the registration safety window. Follow [source deletion recovery](../reference/credential-sources.md#delete-a-source);
leave its Secret in place until the source is gone. Deleting the source removes
the gateway's credential copy as well. The helper remembers the Agent name; use a
new name for the next run.

<span id="troubleshooting"></span>

## Troubleshoot

- **`No Namespace named default exists`:** the command creates its Agent only in
  the `default` Namespace from Local setup. After that Namespace is deleted, its
  name [cannot be reused](../reference/namespaces.md#deletion-and-tombstones), so
  the command cannot run on that installation. Start a new
  [Local setup](quickstart.md); [cleanup](quickstart.md#clean-up-and-stop)
  deletes the current installation and its Agents.
- **`default` stays in `provisioning` or fails:** [check that OCC and Kubernetes are reachable](deploy/local-kubernetes-development.md#verify-the-local-boundary),
  then check the [Namespace status](../reference/namespaces.md#lifecycle).
- **A name is already in use:** use a new name if the existing Agent was
  created through the console or another tool. If this command created it,
  rerun with the same name to
  verify that Agent instead of creating a duplicate.
- **Deployment or the model request fails:** confirm the model is available to
  your OpenAI project and the cluster can reach the provider. To replace an
  invalid key, run `node scripts/first-agent.mjs my-agent --replace-key` and
  supply the new key when prompted. A selected version without
  `Model response verified` is not a successful model check. See
  [Troubleshoot Agents](topics/agent-troubleshoot.md).
- **OpenShell rejects the default Harness:** rerun with `--harness codex` and a
  new Agent name. Embedded OpenClaw remains unsupported with OpenShell.
  Contributors reproducing the Compose-plus-k3d path can use the
  [OpenShell first-Agent handoff](../testing/openshell.md#first-agent-proof) for exact
  setup and recovery checks.

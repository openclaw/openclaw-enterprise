# Deploy your first Agent

Create your own Agent in the Kubernetes installation from [Local setup](quickstart.md),
deploy it, and get a real response from an OpenAI model. You choose the Agent
name and supply your own OpenAI API key. The Agent stays in your installation
after the command exits.

## Before you start

- Complete [Local setup](quickstart.md) and leave the installation running.
- Start Local setup without the OpenShell Sandbox Driver, using
  `OCC_DEVELOPMENT_SANDBOX_DRIVER=none`.
- Use the same checkout and development state directory. If you set
  `OCC_DEVELOPMENT_STATE_DIRECTORY` during setup, use the same value here.
- Have an OpenAI API key that can use [`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra), the default model. To use a
  different model available to your project, set `OPENCLAW_FIRST_AGENT_MODEL`
  to its ID, without `openai/`. IDs served by a model gateway may contain `/`.
- To use another endpoint, set `OPENCLAW_FIRST_AGENT_BASE_URL` to the https URL
  of an OpenAI-compatible endpoint. For an Anthropic model or an
  Anthropic-format endpoint, also set `OPENCLAW_FIRST_AGENT_PROVIDER=anthropic`
  and `OPENCLAW_FIRST_AGENT_MODEL`, and supply the key through
  `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FILE` instead of the OpenAI
  variables below. A repeat run must use the same provider and endpoint; an
  Agent created by an older checkout of this command needs a new name.
- Keep the key out of commands, Configuration JSON, and chat. For automation,
  set `OPENAI_API_KEY_FILE` to a private file containing the key, or supply
  `OPENAI_API_KEY` through your environment's secret manager; setting both
  fails. The command prompts for the key without echoing it only when neither
  is set. An exported key is used as is, so clear a stale one with
  `env -u OPENAI_API_KEY` to be prompted instead.

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

This starter answers model prompts only. Tools and the native admin UI are
disabled. The command refuses to reuse it if you change its Configuration
elsewhere. For an Agent that can use tools or the native admin UI, create a
separate console-managed Agent; see [Agent Configuration](../reference/configuration.md),
[Plugins](../reference/agent-plugins.md), and [local native admin setup](quickstart.md#open-an-agents-native-admin-ui).

Keep the command running until it prints `Model response verified:` followed by
the phrase it asked the model to repeat. Under `Agent response:`, it then prints
the model's answer to your question. It also prints the Agent ID, active
revision, and console URL. These returned responses complete the model check; see
[what each check establishes](operate/model-verification.md#what-each-check-establishes).

<span id="4-check-what-actually-deployed"></span>
<span id="4.-check-what-actually-deployed"></span>

### 3. Find your Agent in the console

Open the console link from the command and sign in with the local credentials
from [Local setup](quickstart.md#open-the-platform-console). **Current version**
shows the revision selected by OCC; **Deployment activity** shows persisted
deployment progress. Use the terminal command for further model prompts. For
browser access to the Agent's files, follow
[workspace verification](deploy/workspace-routing.md#verify-routing-and-file-access).

The Agent remains available after the command exits. Run the same command with
the same Agent name and a different `--prompt` to ask another question; you do
not need to enter the model key again. Stopping the local stack
with `dev down` [deletes the installation and its Agents](quickstart.md#clean-up-and-stop).

## Clean up

To remove only this Agent and keep the installation, delete the Agent and then
the Configuration, Secret, and Role the command created for it. Set
`OCC_NAMESPACE` to the `ID` shown for `default` in step 1, and `AGENT_ID` to the
Agent ID the command printed. If the command stopped before printing it, run the
`export` line first, then find the ID with `./bin/occ agent list`:

```bash
export OCC_NAMESPACE=<default-namespace-id>
AGENT_ID=<agent-id>
AGENT_JSON="$(./bin/occ agent get "$AGENT_ID" -o json)"
CONFIGURATION_ID="$(jq -r .configurationId <<<"$AGENT_JSON")"
SECRET_ID="$(jq -r .harnessAuth.source.id <<<"$AGENT_JSON")"
ROLE_ID="role_local_first_agent_secret_$(printf '%s\0%s' "$AGENT_ID" "$SECRET_ID" |
  sha256sum | cut -d' ' -f1)"
./bin/occ agent delete "$AGENT_ID"
./bin/occ agent get "$AGENT_ID"
```

Repeat `agent get` until it returns `404`, then delete the rest:

```bash
./bin/occ configuration delete "$CONFIGURATION_ID"
./bin/occ secret delete "$SECRET_ID"
./bin/occ iam role delete "$ROLE_ID"
```

Each run creates a separate Role named `Local first Agent Secret access`, so
`occ iam role list` shows one per first Agent until you delete it. The command
remembers the Agent name; use a new name for the next run.

<span id="troubleshooting"></span>

## Troubleshoot

- **`default` stays in `provisioning` or fails:** [check that OCC and Kubernetes are reachable](deploy/local-kubernetes-development.md#verify-the-local-boundary),
  then check the [Namespace status](../reference/namespaces.md#lifecycle).
- **A name is already in use:** use a new name if the existing Agent was
  created through the console or another tool. If this command created it,
  rerun with the same name to
  verify that Agent instead of creating a duplicate.
- **Deployment or the model request fails:** confirm the model is available to
  your OpenAI project and the cluster can reach the provider. To replace an
  invalid key, run `node scripts/first-agent.mjs my-agent --replace-key` and
  supply the new key when prompted. An active revision without
  `Model response verified` is not a successful model check. See
  [Troubleshoot Agents](topics/agent-troubleshoot.md).
- **The selected setup uses OpenShell:** stop that development environment and
  start [Local setup](quickstart.md) without OpenShell. The current OpenShell
  development profile does not support this first-Agent model-turn workflow.

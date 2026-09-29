# Give an Agent repository access

Select approved repositories, deploy an Agent, then use ordinary `git` and `gh`.
GitHub credentials stay in the service. Choose an
[access level](../reference/repository-credentials/access-levels.md) for the task;
the [team runbook](repository-credentials/team-runbook.md) covers App registration,
configuration, a first draft PR and cleanup.

Keep the gateway private to approved clients, with enforced NetworkPolicies and
HTTPS on port 443. A `.svc` hostname or ClusterIP alone does not establish isolation;
check forwarding, Ingress, load balancers and effective policy enforcement.

## Prepare the platform installation

Use Kubernetes Compute-owned **Dedicated Codex** or **Embedded OpenClaw**,
compatible Harness authentication and no Sandbox Driver. Enable the optional credential sidecar
through the [repository installation procedure](repository-credentials/installation.md).
It requires one immutable registry ConfigMap shared by API, worker and service,
a separate public CA Secret, and service-only configuration, App-key and TLS
Secrets. The [registry reference](../reference/repository-credentials.md#canonical-platform-registry)
defines repository and Namespace policy. Set `sessionDurationSeconds: 86400` for
a 24-hour revision; keep it within the registry's maximum.

The chart's `repositoryCredentials.enabled` defaults to `false`. Follow the
installation guide for Backend/Driver selection, images, registry, Secrets,
upstream ranges, certificates and tenant RBAC. Use one worker/service owner with
`Recreate`; replicas cannot share in-memory sessions. Routing does not establish
network isolation.

Build the full Agent runtime from the checkout root and select its immutable
image reference in Compute configuration:

```sh
docker build -f deploy/runtime/Dockerfile \
  -t openclaw-enterprise-runtime:repository-credentials .
```

The image includes Git, the client helper and pinned `gh` 2.100.0. Publish or
import it, select its digest and configure model authentication.

## Create and deploy an Agent

In **Agents** > **Create Agent**, choose up to 16 repositories and one common level.
Use **Dedicated** for Slack on the same Agent; follow the
[same-Agent Console sequence](../reference/console/create-and-deploy.md#use-repositories-and-slack-on-the-same-agent)
for channels, credentials and deployment. Repository profiles and model
authentication are separate. If repository discovery fails, **Create Agent**
stays blocked until discovery succeeds. The exception is
`503 REPOSITORY_OPTIONS_UNAVAILABLE` with no repositories selected: you can save
an ordinary draft, but cannot start guided provisioning. Other errors still
block creation. Creation and deployment recheck Namespace repository policy;
see [repository discovery](../reference/console/create-and-deploy.md#create-an-agent).

The API sequence below shows the Embedded variant.

Complete [Namespace and embedded Agent preparation](deploy/production-agents.md)
to prepare the embedded `configuration.json` and Namespace-owned model Secret
`HARNESS_SECRET_ID`. Enable native command tools before creating the Configuration;
merge these fields into its `values` while preserving the model and gateway settings:

```json
{
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "sandbox": { "mode": "off" }
    }
  },
  "tools": {
    "allow": ["exec", "process"],
    "exec": { "host": "gateway", "mode": "full" }
  }
}
```

This gives the embedded Agent command execution in its gateway container. It is
not an additional sandbox. Create the Configuration as that guide describes and
capture `CONFIGURATION_ID`. Keep its
operator environment, including `OCC_URL`, protected `OCC_SERVICE_KEY_FILE`,
`NAMESPACE_ID` and Kubernetes context. The registry must authorize the actual
platform Namespace ID. The example uses its `application` reference:

```bash
export OCC_NAMESPACE="$NAMESPACE_ID"
export CONFIGURATION_ID HARNESS_SECRET_ID NAMESPACE_ID
python3 - <<'PYTHON'
import json, os
body = {
    "name": "repository-agent",
    "configurationId": os.environ["CONFIGURATION_ID"],
    "executionMode": "embedded",
    "harnessAuth": {
        "method": "api_key",
        "source": {
            "kind": "secret",
            "namespaceId": os.environ["NAMESPACE_ID"],
            "id": os.environ["HARNESS_SECRET_ID"],
        },
    },
    "repositoryBindings": [{"repositoryRef": "application", "profile": "git-write"}],
}
with open("agent.json", "w") as output:
    json.dump(body, output)
PYTHON
AGENT_RESPONSE="$(occ agent create --file agent.json --output json)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export AGENT_ID
```

Select an [access level](../reference/repository-credentials/access-levels.md):
Read-only (`git-read`), Contributor with issue management off (`git-write`), or
Contributor (`git-full`). Send the profile explicitly; omitting it in an API
binding selects `git-write`. The Console's Contributor choice defaults to
`git-full` when approved.
Add approved references for more repositories. API
creation uses `POST /namespaces/$NAMESPACE_ID/agents`; the CLI returns the
unwrapped Agent. Bindings confer no model access: before deploying, complete the
production guide's exact Agent-principal Secret grant and initial transport
credential provisioning. If you lack Installation administration permission,
ask an administrator to grant the Agent's service principal `operate` on the
exact model Secret.

```bash
REVISION_RESPONSE="$(occ agent deploy "$AGENT_ID" --output json)"
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export REVISION_ID
occ agent get "$AGENT_ID" --output json
```

Wait until `activeRevisionId` equals `REVISION_ID`. The admitted revision exposes
repository references, profiles and its fixed deadline. Deployment readiness
alone does not prove a model task or GitHub operation. Failed policy checks,
unsupported topology, missing material or expired authority must be corrected
before proceeding; do not add a PAT as a fallback.

## Ask the Agent to work in the repository

Select the Ready active `GATEWAY_POD` using the
[production TUI procedure](deploy/production-tui.md),
then send a normal model task. Use a repository and temporary branch explicitly
approved for writes; replace `example/project` with the registry's canonical
name:

```bash
REPOSITORY_TASK_SESSION="repository-task-$(date +%Y%m%d%H%M%S)"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" exec -it "$GATEWAY_POD" -c gateway -- \
  env -u OPENAI_API_KEY OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  node /app/openclaw.mjs tui --session "$REPOSITORY_TASK_SESSION" --message \
  'Clone https://github.com/example/project.git into your workspace using the default destination. Create a new branch, configure repository-local Git author name Repository Agent and email agent@example.invalid, add a short repository-access-check.md, commit it, push the new branch, and open a draft PR with gh pr create using an explicit head and body text. Report the commit and PR URL.'
```

The gateway retains its model credential; the TUI client unsets its copy.
The Agent works in `/home/node/.openclaw/workspace` without manual session-opening:

```sh
git clone https://github.com/example/project.git
cd project
git fetch origin
git switch -c agent-example
git config user.name "Repository Agent"
git config user.email "agent@example.invalid"
# Edit files, then git add and git commit.
git push origin HEAD:refs/heads/agent-example
gh pr create -R github.com/example/project --base main --head agent-example \
  --draft --title "Repository access check" --body "Verify the Agent repository workflow."
```

Git resolves normal remotes and push URLs. The scoped credential helper
selects an admitted binding from the effective HTTPS host and repository path.
`OCE_REPOSITORY_REF=application` selects among bindings for the same repository;
it does not override the network destination. Concurrent commands can use
different bindings without changing shared selection state. Local Git settings,
identity, hooks and aliases keep their normal behavior. To prevent accidental
branch pushes, configure the optional
[push-ref guardrail](../reference/repository-credentials/push-ref-guardrail.md).
See
[native routing limits](../reference/repository-credentials.md#client-routing-and-limits)
for configuration overrides and credential retention.

The `gh` router selects from an explicit target or effective Git remotes. Ambiguous
implicit targets require an explicit repository. `gh api` accepts supported relative
paths such as `repos/example/project/pulls/1`; absolute API URLs are refused.
Read-only supports selected API reads. Contributor with issue management off
adds PR writes; Contributor also adds ordinary issue writes. Both writable levels
can permit GraphQL merges, subject to GitHub rules.

Inspect the actual remote commit and PR to confirm completion. If a push or
mutation has an uncertain response, inspect remote state before repeating it.
Stop the Agent through the normal lifecycle when finished; inspect pending
cleanup separately. A worker restart can retain a surviving service session. If
the credential service loses an already delivered session, the revision fails and
its runtime is retired; it cannot automatically receive replacement credentials.
Inspect retained cleanup obligations and explicitly deploy a new authorized
revision to continue. A new deployment neither settles old cleanup nor replays
Git/API operations. The revision's absolute deadline is never renewed; expiry
also requires a new authorized deployment.

## Use the standalone service

<a id="build-and-validate"></a>
<a id="open-and-use-a-session"></a>
<a id="recover-an-admission"></a>
<a id="container-images"></a>
<a id="inspect-and-close"></a>

For independent clients outside the OCC Agent lifecycle, use the
[standalone service guide](repository-credentials/standalone-service.md). It covers
building and starting the service, opening sessions, running Git and GitHub CLI
commands, recovering uncertain admissions, container deployment, and closing sessions.

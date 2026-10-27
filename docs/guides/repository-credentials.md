# Give an Agent repository access

Select approved repositories, deploy an Agent, then use ordinary `git` and the `oce-github` draft helper.
The worker Token Service owns GitHub App credentials. Choose an
[access level](../reference/repository-credentials/access-levels.md) for the task;
the [team runbook](repository-credentials/team-runbook.md) covers App registration,
configuration, a first draft PR and cleanup.

Keep the gateway private to approved clients, with enforced NetworkPolicies and
HTTPS on port 443. A `.svc` hostname or ClusterIP alone does not establish isolation;
check forwarding, Ingress, load balancers and effective policy enforcement.

## Prepare the platform installation

Select `repository.nativeSender` with `repository.preparedGitHub`. Controller
startup rejects the legacy Installation `drivers.repo` selection. Drain accepted
work on its original owner before cutover; do not replay an unknown result. See
[prepared native setup](../reference/repository-credentials/prepared-native-git.md#install-and-check).

Use Kubernetes Compute-owned **Dedicated Codex**, compatible Harness authentication
and no Sandbox Driver. Enable the optional credential sidecar
through the [repository installation procedure](repository-credentials/installation.md).
It requires one immutable registry ConfigMap shared by API, worker and service,
a separate public CA Secret, worker-only App-key and custody Secrets, and sender
configuration and TLS Secrets. The [registry reference](../reference/repository-credentials.md#canonical-platform-registry)
defines repository and Namespace policy. Set `sessionDurationSeconds: 86400` for
a 24-hour version; keep it within the registry's maximum.

The chart's `repositoryCredentials.enabled` defaults to `false`. Follow the
installation guide for Backend/Driver selection, images, registry, Secrets,
upstream ranges, certificates and tenant RBAC. Use one worker/service owner with
`Recreate`; replicas cannot share in-memory sessions. Routing does not establish
network isolation.

From the checkout root, [resolve the OpenClaw build arguments](../../deploy/runtime/README.md#resolve-openclaw-build-arguments)
and build the full Agent runtime in the same Bash shell. Select its immutable
image reference in Compute configuration:

```bash
docker build -f deploy/runtime/Dockerfile \
  "${openclaw_build_args[@]}" \
  -t openclaw-enterprise-runtime:repository-credentials .
```

The image includes Git, the client helper and pinned `gh` 2.103.2. Publish or
import it, select its digest and configure model authentication.

## Keep Git access on the same running Agent

An Agent administrator can approve one repository binding until they remove that approval.
The worker can then open another short session for the same running Agent without an hourly
approval or a replacement Agent. Git can pause between sessions. The approval does not extend a
token, change its repository or permissions, or grant access to a model.

Enable `allowStandingApprovals` in the Installation's repository registry and
`allowStandingApproval` for that repository in the Agent's Namespace. Upgrade the API, worker,
receipt owner and credential service together before enabling this policy. A deployment admitted
with a finite grant keeps its original deadline.

1. Read `GET …/agents/{agentId}/repository-approval-scopes`. Review the resolved repository,
   permissions and allowed operations, and retain its `scopeFingerprint`.
2. Update the Agent with its current `configurationId` and a `repositoryStandingApproval`
   containing `repositoryRef`, a new `approvalId`, `approved: true`, `duration: "until-removed"`,
   and `expectedScopeFingerprint`. If the scope changed, review it again. Deploy the Agent once.
3. To withdraw, read `GET …/agents/{agentId}/repository-approvals`, then send the approval's
   `expectedGeneration` to `POST …/agents/{agentId}/repository-approvals/{approvalId}/remove`.
   Fresh Git requests are denied even while cleanup is pending. A request with an issued one-use
   permit can still start before its original send deadline, even after removal is acknowledged.
   Do not replay a request whose outcome is unknown. See [prepared Git authorization](../reference/repository-credentials/prepared-native-git.md#what-a-request-authorizes).
   On OpenShell, the worker removes Git and continues supervising the same execution if its
   independent permissions still allow it. Stopping the Agent ends that execution.

A refusal answers `409 RESOURCE_CONFLICT` and names the step: review the scope again, keep one
binding, remove the approval before you change the binding, or ask an Installation administrator
to allow standing approval. Deploy refuses an approval that no longer matches policy until you
remove and approve it again.

The worker must recognize the same execution and account for its previous session and credential.
If it returns after a known provider expiry, it waits out the clock allowance and records
`expired` separately from confirmed revocation. An uncertain issuance, installation or retirement
still requires recovery. Do not repeat an operation whose outcome is unknown.

## Create and deploy an Agent

In **Agents** > **Create Agent**, add up to 16 repositories. They inherit
the Agent default; expand a selected repository’s card to customize its access.
Use **Dedicated** for Slack on the same Agent; follow the
[same-Agent Console sequence](../reference/console/repository-access.md#use-repositories-and-slack-on-the-same-agent)
for channels, credentials and deployment. Repository profiles and model
authentication are separate. If repository discovery fails, **Create Agent**
stays blocked until discovery succeeds. The exception is an Installation without
repository access or `503 REPOSITORY_OPTIONS_UNAVAILABLE`, with no repositories selected: you can save
an ordinary draft, but cannot start guided provisioning. Other errors still
block creation. Creation and deployment recheck Namespace repository policy: deploy refuses
saved selections it no longer approves with `409 RESOURCE_CONFLICT`. See [repository discovery](../reference/console/repository-access.md#discover-and-select-repositories).

For the API sequence, complete [Namespace and dedicated Codex preparation](deploy/production-agents.md#configure-the-agent-runtime)
to prepare the Configuration and Namespace-owned model Secret `HARNESS_SECRET_ID`.
Capture `CONFIGURATION_ID` and retain the production guide's
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
    "executionMode": "dedicated",
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

Select `git-write` with one exact ref in the registry. Add `git-and-draft-pr`
and an approved base only when the task needs draft creation.
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
occ agent deployment-status "$AGENT_ID" "$REVISION_ID"
```

Repeat the status command until it reports `succeeded`; a matching
`activeRevisionId` alone can name a version that is still starting or has
failed. The saved version exposes
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
  'Clone https://github.com/example/project.git into your workspace using the default destination. Create a new branch, configure repository-local Git author name Repository Agent and email agent@example.invalid, add a short repository-access-check.md, commit it, push the new branch, and open a draft with oce-github pr-create --draft using the approved head and base and explicit body text. Report the commit and PR URL.'
```

The gateway retains its model credential; the TUI client unsets its copy.

`user.name` and `user.email` identify the commit author; they do not change the
managed GitHub App identity used to authorize a push. A successful authenticated
clone does not configure these values; set them before committing, as shown below.

The dedicated Agent works in its workspace without manual session-opening:

```sh
git clone https://github.com/example/project.git
cd project
git fetch origin
git switch -c agent-work
git config user.name "Repository Agent"
git config user.email "agent@example.invalid"
# Edit files, then git add and git commit.
git push origin HEAD:refs/heads/agent-work
oce-github pr-create --base main --head agent-work \
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

The draft helper requires the registry's exact head and base. With the Git-only
sample policy, draft creation is denied. Select `git-and-draft-pr` and set
`pullRequestBase` before deploying a draft task. General REST and GraphQL
operations are not part of this native profile.

Inspect the actual remote commit and PR to confirm completion. If a push or
mutation has an uncertain response, inspect remote state before repeating it.
Stop the Agent through the normal lifecycle when finished; inspect pending
cleanup separately. A worker restart can retain a surviving service session. If
the credential service loses an already delivered session, the version fails and
its runtime is retired; it cannot automatically receive replacement credentials.
Inspect retained cleanup obligations and explicitly deploy a new authorized
version to continue. A new deployment neither settles old cleanup nor replays
Git/API operations. The version's absolute deadline is never renewed; expiry
also requires a new authorized deployment.

## Use the standalone service

<a id="build-and-validate"></a>
<a id="open-and-use-a-session"></a>
<a id="recover-an-admission"></a>
<a id="container-images"></a>
<a id="inspect-and-close"></a>

For independent clients outside the OCC Agent lifecycle, use the
[standalone service guide](repository-credentials/standalone-service.md). It covers prepared sender setup, the explicit development-token option and
draining an existing signing gateway.

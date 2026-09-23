# Give an Agent repository access

Create and deploy an Agent with approved repository references, then use ordinary
`git` and `gh` commands. The runtime receives gateway session material; GitHub
credentials remain in the service. Choose an
[access level](../reference/repository-credentials/access-levels.md) for the task.

For a team GitHub App, start with the [team runbook](repository-credentials/team-runbook.md)
for App registration, copyable configuration, a first draft PR, and cleanup.

Keep the gateway private to approved clients, with enforced NetworkPolicies and
HTTPS on port 443. A `.svc` hostname or ClusterIP alone does not establish isolation;
check forwarding, Ingress, load balancers and effective policy enforcement.

## Prepare the platform installation

Use Kubernetes Compute-owned **embedded OpenClaw**, `api_key` Harness
authentication and no Sandbox Driver. Enable the optional credential sidecar
through the [repository installation procedure](repository-credentials/installation.md).
It requires one immutable registry ConfigMap shared by API, worker and service,
a separate public CA Secret, and service-only configuration, App-key and TLS
Secrets. The [registry reference](../reference/repository-credentials.md#canonical-platform-registry)
defines repository and Namespace policy. Set `sessionDurationSeconds: 86400` for
a 24-hour revision; keep it within the registry's maximum.

The chart's `repositoryCredentials.enabled` defaults to `false`. Follow the
installation guide for Provider/Driver selection, images, registry, Secrets,
upstream ranges, certificates and tenant RBAC. Use one worker/service owner with
`Recreate`; replicas cannot share in-memory sessions. Routing does not establish
network isolation.

Build the full Agent runtime from the checkout root and select its immutable
image reference in Compute configuration:

```sh
docker build -f deploy/runtime/Dockerfile \
  -t openclaw-enterprise-runtime:repository-credentials .
```

This image contains stock Git, the client helper and pinned `gh` 2.100.0.
Follow the production guides to publish or import it, select its digest and
configure model authentication.

## Create and deploy an Agent

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

Select Reader (`git-read`) for read-only work, Contributor (`git-write`) for
pushes and PRs, or Collaborator (`git-full`) for issue management too. Omitting
`profile` selects Contributor.
Add distinct approved references to the array for more repositories. API
creation uses `POST /namespaces/$NAMESPACE_ID/agents`; the CLI returns the
unwrapped Agent. Bindings confer no model access: before deploying, complete the
production guide's exact Agent-principal Secret grant and initial transport
credential provisioning. Ordinary API-only operators need the administrator's
help with that private principal grant.

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
[production TUI procedure](deploy/production-agents.md#attach-with-the-openclaw-tui),
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

The model-executing gateway keeps its model credential; the TUI client unsets
its copy. The runtime workspace is `/home/node/.openclaw/workspace`. No operator
session-opening or pre-clone step is required. The Agent can use:

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

Stock Git resolves its normal remotes and push URLs. The scoped credential helper
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
Reader supports selected API reads. Contributor adds PR writes; Collaborator
adds ordinary issue writes. Both writable levels can permit GraphQL merges,
subject to GitHub rules.

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

The remaining steps are for independently launched clients. They do not create
an OCC Agent or connect a client container to the platform lifecycle.

## Build and validate

From the repository root with Node 24 and the pinned pnpm dependencies prepared,
build the emitted service and client artifacts:

```sh
pnpm credentials:build
pnpm credentials:check-config /absolute/path/service.json
```

The check validates protected configuration, RSA and TLS inputs without starting
listeners or calling GitHub. The builder emits separate service and client
closures under `.build/repository-credentials`, using Node built-ins without
runtime `node_modules`. The client includes the native Git preparer, GitHub CLI
router and standalone session launcher.

For `invalid-configuration`, inspect the file and every directory in its absolute
path. Use root or service-user ownership, private configuration/key files, and
directories that other users cannot modify. A root-owned sticky temporary
directory is allowed above the protected immediate parent. Move files out of
shared writable deployment directories before retrying; the complete policy is
in the [reference](../reference/repository-credentials.md#configuration).

Create the protected configuration shown in the
[reference](../reference/repository-credentials.md#configuration). Use a GitHub
App installed on the selected repository with the permissions for your chosen
profile. Choose a gateway hostname resolvable by the intended clients and a
matching TLS certificate trusted by those clients; public DNS is not required.
Set `gateway.publicOrigin` to that HTTPS origin. GitHub CLI requires port 443
on that hostname. Restrict gateway access to the approved clients before starting
the listener. Provision a private control directory owned by the service/operator:

```sh
install -d -m 700 /absolute/path/control /absolute/path/sessions
chmod 600 /absolute/path/service.json /absolute/path/app.pem /absolute/path/tls.key
pnpm credentials:start --config /absolute/path/service.json
```

The configured control socket must be inside the private control directory.
Keep the service's configuration, App key, TLS private key and control socket
outside the Agent's filesystem mounts.

## Open and use a session

Keep duration within `maximumDurationSeconds` and select an `allowedProfiles`
entry. Omitting `--profile` uses the configured default, `git-write` here.
Use Reader (`git-read`) for reads and Contributor (`git-write`) for pushes and
PR work. The example selects Collaborator (`git-full`) for issue management too.

The output directory must not exist, and its parent must be owned and mode 0700. The command writes private
files atomically and prints the session identifier, deadline and directory,
without printing the bearer:

```sh
pnpm credentials:operator open \
  --socket /absolute/path/control/control.sock \
  --duration-seconds 86400 --profile git-full \
  --output /absolute/path/sessions/task \
  --ca /absolute/path/gateway-ca.pem
```

Omit `--ca` when the gateway uses a publicly trusted certificate. Protect the
resulting directory like any credential. It contains `bearer`, public metadata,
Git configuration, isolated `gh` configuration and optional public CA trust.
Mount only this private client material and the working directory into the
Agent. Preserve the session files' ownership and mode 0600, and their directories'
mode 0700. Bind-mount only the selected session directory, never its host parent
or sibling sessions. The client validates that directory beneath the protected
container root.

Use the emitted client launcher for each supported command. Its absolute path
continues to work after changing into the cloned repository:

```sh
credential_client=/absolute/path/checkout/.build/repository-credentials/client/dist/drivers/repo/github/credentials/client/launch.js
node "$credential_client" /absolute/path/sessions/task git clone \
  https://credentials.example.internal/example/project.git
cd project
node "$credential_client" \
  /absolute/path/sessions/task git fetch origin
node "$credential_client" \
  /absolute/path/sessions/task git switch an-existing-branch
node "$credential_client" \
  /absolute/path/sessions/task git push origin HEAD:refs/heads/agent-feature
```

Use credential-free HTTPS URLs; the selected session helper supplies authentication.
Git keeps its normal configuration, hooks and worktrees. These native settings
are overridable defaults, so operators remain responsible for inherited URL
credentials and configuration overrides.

Choose a session with the [access level](../reference/repository-credentials/access-levels.md)
required by the operation. The launcher checks that the
executable is exactly `gh` 2.100.0. Create a
request body file in the working directory, then use relative API paths:

```sh
node "$credential_client" /absolute/path/sessions/task gh api \
  --method POST repos/example/project/pulls --input create-pr.json
node "$credential_client" /absolute/path/sessions/task gh api \
  repos/example/project/pulls/1
node "$credential_client" /absolute/path/sessions/task gh api \
  --method PATCH repos/example/project/pulls/1 --input update-pr.json
node "$credential_client" /absolute/path/sessions/task gh api \
  --method POST repos/example/project/issues --input create-issue.json
node "$credential_client" /absolute/path/sessions/task gh api \
  --method POST repos/example/project/issues/1/comments --input comment.json
node "$credential_client" /absolute/path/sessions/task gh api \
  --paginate repos/example/project/issues/1/comments
```

Native PR creation uses an explicit already-pushed head branch:

```sh
node "$credential_client" /absolute/path/sessions/task gh pr create \
  -R github.com/example/project --base main --head agent-feature \
  --title "Example change" --body-file body.md
```

Select a separate branch when trying both REST and native PR creation. Do not
run `gh auth login` or inject a PAT when a command fails. The gateway routes and
exact App permissions define supported access.

## Recover an admission

Run the operator commands from the checkout root. If `open` loses its response,
use the `credential-admission` ID printed to
stderr before dispatch. Repeat the command with the same duration and profile,
adding `--admission-id`:

```sh
pnpm credentials:operator open \
  --socket /absolute/path/control/control.sock \
  --duration-seconds 86400 --profile git-full \
  --output /absolute/path/sessions/task \
  --ca /absolute/path/gateway-ca.pem \
  --admission-id ADMISSION_ID
```

A recovered response contains `recovered: true` and credential-free session status,
without creating client files or returning the bearer again. Close that session
using its reported ID and inspect cleanup status. Then explicitly run `open`
without `--admission-id`, choosing a new output directory if needed.
Do not generate replacement admissions blindly after an ambiguous response.
An unknown stale ID or a service restart cannot recover the original session;
see the [ephemeral-session limits](../reference/repository-credentials.md#sessions-and-closure).

## Container images

From the checkout root, rebuild the artifacts from the source you intend to run,
then build the two images:

```sh
pnpm credentials:build
pnpm credentials:image
pnpm credentials:client-image
```

The scripts use `deploy/runtime/repository-credentials/Dockerfile` and
`Dockerfile.client`, with their respective emitted directories as build contexts.

The service entrypoint is `node /app/dist/repository-credentials.js`; the client
entrypoint is
`node /app/dist/drivers/repo/github/credentials/client/launch.js`. Record the
source commit, working-tree changes and immutable image IDs with verification
results; a reused tag alone does not identify the tested source.

If build-time HTTPS downloads require an additional trusted CA, optionally pass
a PEM CA bundle through a BuildKit secret:

```sh
docker build --secret id=build-ca,src=/absolute/path/build-ca-bundle.pem \
  -f deploy/runtime/repository-credentials/Dockerfile.client \
  -t repository-credentials-client:local .build/repository-credentials/client
```

The secret supplies curl trust for that download step and is not stored in the
image. Without it, curl uses the image's default CA trust. Runtime gateway trust
still comes from the selected session configuration.

Each Dockerfile copies only its artifact's manifest and emitted code. The service
artifact excludes the client command modules; the client artifact excludes the
signing, session and listener owners. The client image installs Git and checksum-verifies pinned `gh`
2.100.0. Neither image includes service configuration, private keys, session
files or a control socket. The client entrypoint takes `SESSION_DIRECTORY
 git|gh ARGS...`.

The optional `deploy/examples/repository-credentials/compose.yaml` maps port 443
on an explicitly selected private host IPv4 address to the service's port 8443.
Set `CREDENTIAL_SERVICE_PRIVATE_ADDRESS` to an address assigned to the host and
reachable from the separate client container. Do not use a wildcard address or
loopback: the client's loopback address refers to its own container. Before
starting the service, enforce host/container-network access controls that allow
only approved clients to reach this published port and the container listener.
The example does not install those controls; a private address alone is not an
access policy. Keep this endpoint off public forwarding, Ingress and load balancers.

Set `CREDENTIAL_GATEWAY_HOSTNAME` to the hostname in `gateway.publicOrigin`, such
as `credentials.example.internal`, with a matching trusted TLS certificate. The
client's `extra_hosts` entry resolves it to the selected private host address so
the client uses HTTPS port 443. Retain `gateway.listen` as `0.0.0.0:8443` inside
the service container. Any approved host client also needs hostname resolution
to the private address and the same CA trust; Compose supplies neither for the host.

Supply `CREDENTIAL_SERVICE_UID`, `CREDENTIAL_SERVICE_GID`,
`CREDENTIAL_SERVICE_INPUTS`, `CREDENTIAL_SERVICE_CONTROL`,
`CREDENTIAL_CLIENT_SESSION`, and `CREDENTIAL_CLIENT_WORKSPACE`. Match the UID/GID
to the protected files. Set `CREDENTIAL_CLIENT_SESSION` to only the selected
directory, such as `/absolute/path/sessions/task`; it appears as `/session` in
the client. Service/control mounts remain separate from client mounts, and the
reference configuration's file paths match these mounts. After configuring
private access and certificate trust, render the configuration and run the client:

```sh
docker compose -f deploy/examples/repository-credentials/compose.yaml config
docker compose -f deploy/examples/repository-credentials/compose.yaml up -d --build service
docker compose -f deploy/examples/repository-credentials/compose.yaml run --rm --build client \
  /session git clone https://credentials.example.internal/example/project.git
```

Rendering Compose checks declared configuration. To verify delivered separation,
inspect the running service/client mounts and client surfaces using the
[container qualification procedure](../testing/repository-credentials.md#verify-separate-running-containers).
Also verify approved client connectivity and denied access from an unapproved
workload and the relevant external network, without copying a session bearer
into reachability probes. Neither a Compose rendering nor image inspection
establishes deployment isolation or live GitHub compatibility.

## Inspect and close

From the OCE source checkout:

```sh
pnpm credentials:operator status --socket /absolute/path/control/control.sock \
  --session SESSION_ID
pnpm credentials:operator close --socket /absolute/path/control/control.sock \
  --session SESSION_ID
```

Inspect cleanup status after local closure. Pending or uncertain cleanup remains
an obligation. Shutdown stops after its finite grace period even when cleanup
remains unresolved; process exit is not proof of revocation. If writing client
files fails after admission, the CLI attempts local closure and prints the affected
session ID so you can inspect it.

For an uncertain push or mutation, inspect remote state before deciding on a
new operation. For authentication failures, check the selected profile,
installation permission, repository identity and TLS/DNS configuration. A moved
repository requires trusted configuration refresh. After a process restart,
admit a new session; old gateway bearers are invalid. Remove the old private
client directory after closing its session and recording any pending cleanup.

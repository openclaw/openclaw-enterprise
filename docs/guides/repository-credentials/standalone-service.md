# Run the repository credential service

Use this procedure to launch independent Git and GitHub CLI clients without
creating an OCC Agent or joining the platform lifecycle. To give a managed Agent
repository access, follow [the Agent guide](../repository-credentials.md).

You need a private service host, approved GitHub App access, TLS, and protected
storage for service configuration and client sessions. Keep the gateway private
to approved clients with enforced network access controls and HTTPS on port 443.
A private address alone does not establish isolation.

## Build and validate

From the repository root with Node 24 and the pinned pnpm dependencies prepared,
build the emitted service and client artifacts:

```sh
pnpm credentials:build
pnpm credentials:check-config /absolute/path/service.json
```

The check validates protected configuration, RSA and TLS inputs without listeners
or GitHub calls. The builder emits separate service and client closures under
`.build/repository-credentials`, using Node built-ins without runtime `node_modules`.

For `invalid-configuration`, inspect the file and every directory in its absolute
path. Use root or service-user ownership, private configuration/key files, and
directories that other users cannot modify. A root-owned sticky temporary
directory is allowed above the protected immediate parent. Move files out of
shared writable deployment directories before retrying; the complete policy is
in the [reference](../../reference/repository-credentials.md#configuration).

Create the protected configuration shown in the
[reference](../../reference/repository-credentials.md#configuration). Use a GitHub
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
Use Read-only (`git-read`) for reads and Contributor with issue management off
(`git-write`) for pushes and PR work. The example selects Contributor (`git-full`)
for issue management too.

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

Choose a session with the [access level](../../reference/repository-credentials/access-levels.md)
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
see the [ephemeral-session limits](../../reference/repository-credentials.md#sessions-and-closure).

## Container images

From the checkout root, rebuild the artifacts from the source you intend to run,
then build the two images:

```sh
pnpm credentials:build
pnpm credentials:image
pnpm credentials:client-image
```

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
[container qualification procedure](../../testing/repository-credentials.md#verify-separate-running-containers).
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

# Strands Box SandboxDriver example

This external Driver connects a dedicated Codex revision to one operator-owned
Strands Box execution. OpenClaw Control Plane selects the Driver. Stock Kubernetes
Compute supplies the command, image, workspace mounts, files, environment and
transport verifier. The host matches those inputs to its independently admitted
execution. A private relay carries the existing Harness WebSocket protocol.

This example supports ordinary execution with a controlled, non-authorizing
inference fixture. Without `protectedRepository` it does not register a Credential
Proxy or provide protected Git: the paired loader refuses it, and the Driver
refuses protected revision inputs, credential attachments, a projected workload
identity or initial workspace files before starting the Box. With
`protectedRepository` the package returns the
[paired protected registration](#paired-protected-registration) instead, which
the ordinary `drivers.sandbox` loader refuses.

The Driver reports `serving` only after the original Codex server answers the
Driver’s authenticated JSON-RPC `initialize` request. Check the actual Box,
network route, and workspace node before using the installation.

## Build and select

From the repository root with the pinned Node and pnpm and the frozen
dependencies installed:

```sh
node deploy/examples/strands-box/driver/build.ts
pnpm --dir deploy/examples/strands-box/driver pack
```

The archive contains a precompiled ESM entry point and its declarations. Install
the reviewed package at its exact version as a direct production dependency of
the Controller, using the [external Driver installation procedure](../../../../docs/reference/drivers/selection.md).
Use the controller workspace copies of `@openclaw-enterprise/contracts`,
`@openclaw-enterprise/occ` and `@openclaw-enterprise/utils` for its peer
dependencies. API and Worker must load the same selected package and
configuration.

Add the `sandbox` selection to the stock Kubernetes Compute Installation. The
following values illustrate the shape. Replace the certificate, addresses,
digest, Namespace and selectors with the actual operator-owned values.

```yaml
drivers:
  sandbox:
    id: strands-box-demo
    package: "@openclaw-enterprise/example-strands-box-driver"
    configuration:
      namespace: pilot
      controlSocket: /run/strands-box/control.sock
      nativeEndpoint: wss://box-harness.pilot.svc.cluster.local:8443/
      nativeCaBundle: |
        -----BEGIN CERTIFICATE-----
        <public ingress CA certificate>
        -----END CERTIFICATE-----
      workspaceRoot: /home/node/workspace
      workspaceNodeMode: file-only-v1
      relay:
        image: registry.example/strands-box-relay@sha256:<relay image digest>
        hostAddress: 10.0.0.7
        installation: pilot
        workerPeer:
          namespace: occ-system
          podLabels:
            app.kubernetes.io/name: occ-worker
      controlledInference:
        modelBaseUrl: https://model.pilot.example.com:8444/v1
        address: 10.0.0.9
```

Use an existing ready OCE Agent Namespace. On a fresh control plane,
complete [normal Namespace provisioning](../../../../docs/guides/deploy/production-agents.md#prepare-each-namespace)
without the Box control mount or an Agent deployment. Return the Worker to
zero before the checks below. In the assigned Kubernetes namespace, create the [private relay Service](../ingress/service.yaml) and read its ClusterIP.
Set Compute's `network.providerHarness` to that namespace, the allocated ClusterIP,
port 8443, and the Service peer labels `box.openclaw.dev/component: harness-relay`
and `box.openclaw.dev/installation: pilot`. Install the relay image at the
configured digest. Use the [verified Worker control mount](worker-control.md#mount-the-empty-control-directory).
To verify each selected Pod belongs to the relay Deployment, the Worker also needs
permission to read its ReplicaSet. In the Agent's Kubernetes namespace, grant
that permission to the actual Worker ServiceAccount:

```bash
kubectl -n "$AGENT_NAMESPACE" create role box-relay-read-replicaset \
  --verb=get --resource=replicasets.apps
kubectl -n "$AGENT_NAMESPACE" create rolebinding box-relay-read-replicaset \
  --role=box-relay-read-replicaset --serviceaccount="$WORKER_NAMESPACE:$WORKER_SERVICE_ACCOUNT"
```

The socket and its parent directory must be owner-only and share the same
owner. Do not mount the control socket into the relay or the workload.

For a controlled inference fixture, set Compute's model provider to the same
HTTPS `/v1` origin. Save an ordinary API-key binding with the public
marker `openclaw-strands-controlled-inference-v1`. The fixture origin must not
require or authorize any real credential. The Driver checks the exact
revision-owned projection and the admitted runtime manifest, and sends only the
nonsecret route described below to the host. It never passes a model key or PAT
to Box. Without the fixture selection it refuses model Secret projections.

### Controlled inference route

Box verifies the model endpoint's certificate against its built-in public
roots, so a private IPv4 or `.svc.cluster.local` name cannot complete TLS.
Name the endpoint with an operator DNS name and pin one private address:

| Field | Value |
|---|---|
| `modelBaseUrl` | `https://<name or private IPv4>[:<port>]/v1`, as Compute normalizes it: lowercase, no trailing slash, no `:443` |
| `address` | The private IPv4 address the name resolves to on the Box host. Required for a name |
| `caSha256` | Only with a host upstream CA bundle: its SHA-256 |

Set the same route here, in Compute's model provider `baseUrl`, and in the
host's `controlledInference` (`url`, `address`, `caSha256`). Approval of
`pending.json` admits that route. The Driver refuses a different host route
before approval, Secret reads or relay creation, and on every later read; the
host refuses a different Driver route before Box starts, and a name its
resolver maps anywhere but the pinned address. Box's policy then permits only
the name and port, then only the pinned `ip4`, never IPv6.

For the certificate, use one of:

- **A publicly trusted certificate** for the name. Resolve the name to the
  pinned address on the Box host through a private zone or a root-owned
  `/etc/hosts` entry. The name appears in Certificate Transparency logs.
- **An upstream CA bundle**: host `upstreamCa` is `{ "file", "sha256" }`, CA
  certificates only, owned by the host owner or root, not group- or
  world-writable. The host names a verified copy in Box's private configuration
  directory with the `upstream-ca-file` key of strands-agents/box#147, which
  stock Box v0.2.2 refuses. Box trusts the bundle for every upstream it dials,
  so every route Box dials must set `caSha256` to its digest or the host refuses
  to start. An inline workspace node must opt in; a separate file node is
  unaffected. Use a dedicated CA.

### Worker control claim

Before the Worker mounts the host control directory, run the
[control claim checks](worker-control.md): prebind the dedicated PVC,
[mount the empty directory read-only in one Worker](worker-control.md#mount-the-empty-control-directory)
and [verify the live mount](worker-control.md#verify-the-live-worker-control-mount) before approval.

## Paired protected registration

> [!WARNING]
> Dogfood stage: the host needs a Box build with the request-time credential
> source, and OCE applies no draft or branch rule to `gh`'s API requests. Do
> not use this beyond a dogfood host. See the
> [known gaps](../KNOWN-GAPS.md#github-access-needs-the-box-forks-request-time-credential-source).

Add `protectedRepository` to the Driver configuration and select the same Driver
as `drivers.credential_proxy` with an empty configuration:

```json
{
  "drivers": {
    "sandbox": {
      "id": "strands-box",
      "package": "@openclaw-enterprise/example-strands-box-driver",
      "configuration": {
        "...": "the ordinary settings above",
        "protectedRepository": { "provider": "github" }
      }
    },
    "credential_proxy": { "id": "strands-box", "configuration": {} }
  }
}
```

The host configuration needs the same setting, `"protectedRepository":
{ "provider": "github" }`. The repository, branch and base come from the
Agent's repository assignment, not from configuration. The host refuses wiring
that differs from its own GitHub routes.

The registration provides:

- the protected Sandbox Driver (`provisionHarness`, `protectedWorkspaceEndpoint`,
  `enrollHarness`, `repositoryAccess`). It admits only a protected v5 revision
  with one online-request GitHub repository plan, no other egress route, a
  dedicated Codex Harness and the empty protected artifact policy it
  acknowledged. Its only credential attachment is its own model source's. It sends the host a
  fresh 256-bit execution bearer in `PUT /v1/execution`. The host keeps only
  its SHA-256 and reports it with the host control process identity: together
  they are the recipient that Compute commits. `enrollHarness` asks Compute for
  two releases of that committed installation. The first is for a startup ID
  the Driver picks. It goes to `POST /v1/release`, and the host opens its
  startup gate only after it verifies the signature for that held execution.
  On a later pass, the Driver relays the stock protected Harness program's own
  challenge, as the bundled OpenShell Driver does (see below).
- the Credential Proxy (`sourceControl`, `configureRevision`, `wiringStatus`,
  `verifyInstallation`, `removeRevision`, `bindRepositoryGit`). The installation
  that Compute commits is built only from what the host reports. The binding
  needs OCE's `requests` port. No token is delivered to the host. After the
  revision activates, OCE prepares the installation token, and the Worker
  confirms each version, the first and every renewal, as ready to be asked for.
  It confirms only while the host reports the live `box run` asking it.

Box injects GitHub credentials itself and asks for each request. The host
starts the released `box run` with one request-time credential source,
`[gateway.credential_source.oce]`, on `<runtimeDir>/source/oce.sock`. The
directory has mode `0700` and no workload grant covers it. Box authenticates
with the execution bearer, which only the `box run` environment holds, as
`OCE_SOURCE_BEARER`. Two routes use the source:

- `github.com` (`github-git`): Basic authentication `x-access-token:<token>`,
  attached to every request (`inject = "always"`), because Git's first request
  carries no credential.
- `api.github.com` (`github-api`): `Authorization: token <token>`, replacing
  the `GITHUB_TOKEN` placeholder.

For each request that Box's policy permits:

1. Box posts the request (target, headers, base64 body, a request ID) to the
   source socket.
2. The host checks the bearer's SHA-256, the target (the two hosts on port 443,
   the route's methods) and the body cap (4 MiB). It queues the ask for the
   Worker, which collects asks with `POST /v1/credential-asks` on the owner-only
   control socket.
3. The Driver checks the ask against the committed recipient and its confirmed
   route, then calls `requests.authorize` with the `github_repository`
   profile. OCE classifies the request, applies the grant's rules, records one
   use and answers.
4. The Driver answers with `POST /v1/credential-answers`. An allow becomes
   `{credential, send_by_unix_ms}`: `x-access-token:<token>` for Git, the bare
   token for the API. A refusal becomes `{refusal: <reason code>}`, which Box
   shows the workload as `credential refused by its source: <code>`.
5. Box places the value for that one request and sends it.

Every failure is a refusal. That includes an unknown execution, a wrong bearer,
a malformed ask, a request outside the two routes, a body over the cap, a past
deadline, and no answer within Box's timeout. The host keeps no credential and
nothing is retried. Renewal needs no restart: the next ask gets the new token.
After the repository assignment is withdrawn, OCE refuses the next request with
`access_withdrawn` before Box sends it, and the Box execution and its chat keep
running.

### Harness enrollment

The stock protected Harness program verifies its own startup release. Before
Codex starts, it serves a challenge on its port at
`/openclaw/runtime/egress-enrollment`, and the challenge carries a fresh
startup ID. Only a Compute-signed release of that challenge starts the
program. It waits at most 180 seconds. So the program can check the release
itself, the host passes two public values into Box:

- `OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID`, the admitted revision ID;
- `OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY`, Compute's Ed25519 verification
  key.

Neither value authorizes anything. The transport token never enters Box's
environment or files.

Before Codex listens, Box has one route in, the enrollment bridge. Before it
waits at the host gate, `box-agent` listens on `bridge/enroll.sock`. Nothing
else runs in Box at that point. Before it opens the gate, the host links that
socket to a path only the host can use. `box-agent` forwards a connection only
when its first line is `GET` or `POST` on the enrollment path. It forwards only
to the port listener held by the program's own process tree, not by Codex. It
closes the bridge when Codex listens. Nothing on the host listens for Box on
this path.

The Driver calls `POST /v1/enrollment` with the execution key and the
transport token. If the request also carries a release, the host delivers it.
The host builds the two requests itself. It relays only after these checks
pass:

- The bearer's SHA-256 equals the admitted `APP_TOKEN_SHA`.
- The execution is held, its gate is open, and it is still starting.
- For a release: Compute signed it for this execution and recipient, it has
  not expired, and its challenge is exactly the challenge the host relayed
  last.

The Driver treats the challenge as untrusted input. It requires the release
profile, a UUIDv4 startup ID, and a binding equal to the admitted plan's
projection, which Compute also renders. Only then does it ask Compute to sign.
It then requires the program's `{enrolled: true, startupId}`.

The Driver retries on the next pass in these cases:

- the program is not listening yet;
- the program answers the read with something other than a challenge;
- the release gets `409` or `410`, which means a restarted or expired program.

Once the host reports the execution running, the Driver does nothing more.
Each gated run waits up to 180 seconds plus the usual bootstrap time for
Codex's listener.

### Protected model route

With `modelGateway` (`secretNamespace`, optional `kubernetes` overrides) and
`controlledInference`, the registration also returns a Credential Gateway view
(select it as `drivers.credential_gateway`). It offers one source type,
`openai` (API key, `authorized_base_url` = `modelBaseUrl`), keeps each key in
its own Secret and attaches it as `strands-box-model:<sourceId>`. The wiring
(version 4) adds `harnessModel`. The host starts `box run` with a second source,
`[gateway.credential_source.oce-model]` on `<runtimeDir>/source/model.sock`
(16 MiB body cap), and one route on the model host and port, path
`<base>/responses`, header `Authorization: Bearer`, placeholder
`OPENAI_API_KEY`. The host checks the target, drops headers and body, and
queues only the target. The Driver answers only for the execution OCE confirmed,
re-observed per request, and reads the Secret of the Namespace and source in
OCE's committed plan, never those the host reports. It also checks the bearer
and the host's live, unrevoked attachment, and sends a 4 s send-by (the host
allows 5 s). `withdraw` posts `POST /v1/model-revoke`; the host writes a receipt
for the revision and source in `protectedModel.revocationDir`, with or without
a running execution, and refuses that revision's model requests itself from then
on. The host buffers at most two of Box's largest model requests at once.

The Agent Gateway sends a protected Box turn with the same
`externalSandbox` policy and `networkAccess: "restricted"` as an ordinary Box
turn. Under that policy Codex applies no network sandbox of its own; it only
sets `CODEX_SANDBOX_NETWORK_DISABLED=1` for commands. Box egress, with
`github.com` and `api.github.com` as the only GitHub destinations, is the
network fence.

## Execution lifecycle

The Worker sends the exact admitted workload and its canonical JSON SHA-256 to
`POST /v1/admission` over the private Unix socket. The host records the pending
workload, then the Worker waits for approval within its normal deployment
deadline. No Secret is read by this Driver while the request is held.

On the host, read `pending.json` in the host's configured `runtimeDir` and
independently match its owner to the selected Installation, Agent and live
pending revision. The approval directory is outside the Worker's read-only
socket mount and every Box grant. The Worker cannot write an approval through
the socket. Follow [the held approval procedure](../ordinary-chat/installed.md#start-the-held-host-and-approve)
after the live mount check.

On the next reconciliation, the same approved workload can proceed. If it
includes a workspace-node pairing Secret, the Driver reads that exact key with
the stock ownership and envelope check, checks the host again, and passes the
one-shot code only to `PUT /v1/execution`. The host rechecks approval, retains
execution intent before launch, and does not return the code or persist it. The
`APP_TOKEN_SHA` supplied by Compute is a verifier. The raw Harness transport
capability stays on the existing authenticated Harness path.

The Driver reads the host execution back before creating the exact Kubernetes
relay Deployment with one replica and observes the relay objects after
creation. The standard Worker creates the Deployment with its existing
permissions. Kubernetes marks the relay Pod ready only when its real probe reaches the original native listener
through the private TLS route. Separately, the Driver compares the live
execution to the provisioned relay and sends `initialize` to Codex over the
verified TLS route using Compute's Harness transport token. The Driver reports
serving only after Codex returns a compatible result for that exact request
within the probe deadline. The host and relay must still name the same execution
afterward. During removal, the Driver
uses Kubernetes deletion preconditions, confirms the relay Pods are gone,
retires the exact host execution and checks for its absence.

For the [ordinary installed example](../ordinary-chat/installed.md), select
`workspaceNodeMode: file-only-v1` alongside `controlledInference`. The Driver
reads the bound workspace claim through its existing namespaced object client.
The host must match that UID and volume name to its own pinned mount before
admission. The host starts the stock file-only node outside Box on a fixed TLS
route to its Agent Gateway. The node keeps its own device state.

After the original Box listener starts, the Driver carries its receipt digest to
Compute and checks that same digest on the authenticated native upgrade.
Compute installs the binding with the ingress CA for that revision. The Gateway
checks the binding before using Box's restricted workspace policy. The ordinary
source and packaging tests do not qualify the installed network or volume.

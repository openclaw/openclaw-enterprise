# Protected metadata sender threat model

This page covers the qualified protected metadata exchange implemented by the
deprecated legacy credential-egress Driver. It does not describe native
TokenService and Credential Proxy injection.

Assume a downloaded script can read the Agent's environment and files, run
commands and open network connections. In the credential-free repository metadata profile,
the grant covers the whole Agent execution. The trusted sender controls which
requests reach GitHub and which responses return to that execution. See the
[protected metadata read](../../design/credential-proxy.md#read-one-repositorys-identity).

## What can a process inside the execution do?

| Attempt by the script                          | Decision on the protected metadata path                                                                                      | What the script can still learn or do                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Run a child process to make the approved read. | The sender accepts a bodyless `GET /repos/acme/widgets` if the execution's current grant permits it.                         | The child can read and copy the approved result, regardless of which command the operator expected.                   |
| Create a pull request at the same host.        | The adapter checks method, origin, path, headers and body. `POST /repos/acme/widgets/pulls` fails before send authorization. | The grant covers the original read. A GET for another repository also fails.                                          |
| Read extra fields from GitHub's reply.         | The sender holds the whole reply. The adapter checks the ID and name and releases only `id` and the granted `full_name`.     | The script can keep those two fields. The sender withholds a redirect, ambiguous JSON or a reply with a different ID. |

Ordinary OpenShell delivery can expose a placeholder that a child
can use at the allowed endpoint. The separate prepared Git sender puts a usable repository session
credential in the workload. Direct Harness authentication can supply a real
model credential to the process that runs the Agent. See
[OpenShell enforcement limits](../credential-sources.md#implementation-status),
[prepared Git sessions](../repository-credentials/prepared-native-git.md) and
[direct Harness credentials](runtime-isolation.md#temporary-runtime-credential-exceptions).

## What stops another execution or a direct connection?

**Copied request handle.** The OpenClaw Control Plane (OCC) checks the authenticated sender, Sandbox,
running installation and original connection. Another execution of the same
Agent cannot reuse the handle or claim the response. If the original connection
closes, the sender withholds the response. The provider may already have received
the request. See the [protected request flow](../../flows/credential-source-egress.md).

**Direct connection.** The installed Sandbox and its network controls must
force provider traffic through the sender. A script with another route can bypass
the request and response checks, even on a credential-free read. A proxy setting or a
startup hook cannot establish that every request takes this path. See the
[installed bypass checks](../../testing/static-egress.md#select-the-prepared-connected-lane).

Stock OpenShell 0.1.5 and 0.1.6 offer a separately approved installation-wide GitHub
preview. GitHub installation membership, permissions and branch rules bound
that access. OpenClaw Enterprise adds no Git ref allowlist for the installation
preview. Repository-scoped access has separate grant and request-binding checks.
See [OpenShell Git profiles](../repository-credentials/protected-openshell-git.md).

## What happens when access changes?

Withdraw the metadata source binding from the Agent's running revision to
stop the walkthrough's read. OCC checks access before selecting the operation
and again before authorizing the send. A withdrawal between those checks denies
the send.
A request that already has a permit can still reach GitHub. If the outcome
is unknown, inspect the original attempt. Repeating a possible write can apply it twice.
See [send authorization](../../../packages/occ/src/credential-proxy.ts) and
[source withdrawal](../credential-sources/withdrawal.md).

Git access through `repositoryAccess` has its own approval. An operator can
withdraw Git approval while a separate metadata Source still permits its read.
OCC denial, removal of an installed route and revocation or expiry at GitHub
are separate events. See the
[Token Service lifecycle](../repository-credentials.md#token-service-lifecycle).

In the [withdrawal example](../../../tests/integration/credential-proxy-withdrawal.test.ts), the operator removes binding A while B keeps working. After B is withdrawn, OCC denies it, but the test peer still returns `200` until policy takes effect. After policy application and restart, the stored plan has no routes and both requests receive `403`. An installed sender needs its own [custody and withdrawal checks](../../testing/protected-repository-custody.md#qualify-installed-custody).

## Who remains trusted?

- **OCC and the provider adapter** decide which operation a sender may perform and which bytes it may return. The sender sees the full provider response and any credential header supplied for other profiles.
- **Sandbox and network administrators** can change the sender, its trust roots or where traffic goes. An administrator who redirects traffic can defeat the sender's checks.

Once the workload receives data, withdrawal cannot take it back. See
[credential custody](../credential-sources.md) and
[OpenShell administrative access](../drivers/openshell-sandbox.md#qualification-contract).

OpenShell Workspace members can attach any Provider in that Workspace. Keep
OCC's management principal as the only member of OCC Workspaces and limit
OpenShell Platform Admins, who bypass membership. OCC does not validate either
membership or the administrator list. Its management identity can manage
Workspaces, Sandboxes, and Providers; keep it outside tenant workloads.
The [metadata adapter](../../../apps/controller/src/drivers/egress-proxy/github-metadata.ts)
defines the implemented read. [RFC-0023](../../../specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md)
describes the broader proposal. A controlled peer shows what reached that peer.
Confirming that a particular build reached GitHub requires evidence from that build and provider.

# Credential Proxy threat model

Assume a downloaded script can read the Agent's environment and files, run
commands and open network connections. In the protected GitHub metadata profile,
the grant covers the whole Agent execution. The trusted sender controls which
requests reach GitHub and which responses return to that execution. See the
[worked repository read](../../design/credential-proxy.md#read-one-repositorys-identity).

## What can a process inside the execution do?

| Attempt by the script                                     | Decision on the protected metadata path                                                                                     | What the script can still learn or do                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Search the environment and files for a GitHub credential. | The issuer keeps the App signing key. The trusted sender adds the installation token outside the workload.                  | The script may find a source ID. The ID alone gives it no access.                                                     |
| Run a child process to make the approved read.            | The sender accepts a bodyless `GET /repos/acme/widgets` if the execution's current grant permits it.                        | The child can read and copy the approved result, regardless of which command the operator expected.                   |
| Create a pull request at the same host.                   | The adapter checks method, origin, path, headers and body. `POST /repos/acme/widgets/pulls` fails before credential access. | The grant covers the original read. A GET for another repository also fails.                                          |
| Read extra fields from GitHub's reply.                    | The sender holds the whole reply. The adapter checks the ID and name and releases only `id` and the granted `full_name`.    | The script can keep those two fields. The sender withholds a redirect, ambiguous JSON or a reply with a different ID. |

The credential-free metadata profile makes the same request and response checks
without reading a credential. Ordinary OpenShell delivery can expose a placeholder that a child
can use at the allowed endpoint. Native Git puts a usable repository session
credential in the workload. Direct Harness authentication can supply a real
model credential to the process that runs the Agent. See
[OpenShell process matching](../drivers/openshell-credential-gateway.md#what-the-boundary-covers),
[native Git sessions](../repository-credentials/prepared-native-git.md) and
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
[installed bypass checks](../../testing/protected-repository-custody.md#qualify-installed-custody).

Stock OpenShell 0.1.5 and 0.1.6 offer a separately approved installation-wide GitHub
preview. GitHub installation membership, permissions and branch rules bound
that access. OpenClaw Enterprise adds no Git ref allowlist for the installation
preview. Repository-scoped access has separate grant and request-binding checks.
See [OpenShell Git profiles](../repository-credentials/protected-openshell-git.md).

## What happens when access changes?

Withdraw the metadata source binding from the Agent's running revision to
stop the walkthrough's read. OCC checks access before selecting a token and again
before authorizing the send. A withdrawal between those checks denies the send. Renewal can also invalidate the selected token version.
A request that already has a permit can still reach GitHub. If the outcome
is unknown, inspect the original attempt. Repeating a possible write can apply it twice.
See [send authorization](../../../packages/occ/src/credential-proxy.ts) and
[source withdrawal](../credential-sources/withdrawal.md).

Git access through `repositoryBindings` has its own approval and execution
session. An operator can withdraw Git approval while a separately bound metadata
source still permits the read. Git approval can be standing or time-limited.
The session expires in either case. Both profiles stop using a token at a local
cutoff before its GitHub expiry. OCC denial, removal of an installed route and
revocation or expiry at GitHub are separate events. See the
[Token Service lifecycle](../repository-credentials.md#token-service-lifecycle).

In the [withdrawal example](../../../tests/integration/credential-proxy-withdrawal.test.ts), the operator removes binding A while B keeps working. After B is withdrawn, OCC denies it, but the test peer still returns `200` until policy takes effect. After policy application and restart, the stored plan has no routes and both requests receive `403`. An installed sender needs its own [custody and bypass checks](../../testing/protected-repository-custody.md#qualify-installed-custody).

## Who remains trusted?

- **OCC and the provider adapter** decide which operation a sender may perform and which bytes it may return. The sender sees the usable credential header and the full provider response.
- **The issuer** holds the GitHub App signing key and can request installation tokens. A bearer token copied on the trusted side remains usable within its GitHub scope and lifetime.
- **Sandbox and network administrators** can change the sender, its trust roots or where traffic goes. An administrator who redirects traffic can defeat the sender's checks.

Once the workload receives data, withdrawal cannot take it back. See
[credential custody](../credential-sources.md) and
[OpenShell administrative access](../drivers/openshell-credential-gateway.md#trust-requirements).
The [metadata adapter](../../../apps/controller/src/drivers/egress-proxy/github-metadata.ts)
defines the implemented read. [RFC-0023](../../../specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md)
describes the broader proposal. A controlled peer shows what reached that peer.
Confirming that a particular build reached GitHub requires evidence from that build and provider.

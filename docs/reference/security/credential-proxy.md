# Protected metadata sender threat model

This page records the threat model for the retired protected metadata exchange
in earlier releases. Ordinary network-only metadata reads return the upstream
response without the historical exchange's field filtering or live OCC checks.

Assume a downloaded script can read the Agent's environment and files, run
commands and open network connections. In the credential-free repository metadata profile,
the grant covers the whole Agent execution. The trusted sender controls which
requests reach GitHub and which responses return to that execution. See the
[retired protected metadata exchange](../credential-sources/protected-repository-metadata.md).

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

Earlier releases offered a separately approved installation-wide GitHub
preview on stock OpenShell 0.1.5 and 0.1.6. GitHub installation membership,
permissions, and branch rules bounded that access. See the
[retired OpenShell Git profiles](../repository-credentials/protected-openshell-git.md).

## What happens when access changes?

OCC checked the metadata Source before selecting the operation and again
before issuing a send permit. Withdrawal between those checks denied the send.
A permitted request could still reach GitHub. Git access had its own approval,
separate from the metadata Source binding.

The [historical withdrawal test](https://github.com/openclaw/openclaw-enterprise/blob/67865414220f9d67820f165fe932fe23df025322/tests/integration/credential-proxy-withdrawal.test.ts)
showed that OCC could deny a withdrawn Source before the installed route stopped
serving it. After policy application and restart, both withdrawn routes returned
`403`.

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
The [metadata adapter](https://github.com/openclaw/openclaw-enterprise/blob/67865414220f9d67820f165fe932fe23df025322/apps/controller/src/drivers/egress-proxy/github-metadata.ts)
defines the implemented read. [RFC-0023](../../../specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md)
describes the broader proposal. A controlled peer shows what reached that peer.
Confirming that a particular build reached GitHub requires evidence from that build and provider.

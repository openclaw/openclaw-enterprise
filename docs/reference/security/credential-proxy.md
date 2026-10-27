# Credential Proxy threat model

Assume that a dependency in the Agent can run arbitrary commands, read the
workload's configuration and open network connections. In the protected
metadata profile, the grant covers the whole admitted execution. The boundary
separates that execution from the trusted sender, control plane and credential
owner. It includes the return path to the caller. Follow the
[repository read](../../design/credential-proxy.md#read-one-repositorys-identity)
across that boundary.

## What can a process inside the execution do?

| Attempt                                                 | Who enforces the limit and what the caller sees                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Print the environment or copy a credential file.        | The protected metadata path keeps the GitHub App signing key and installation token outside the workload. Other delivery modes expose different values. Ordinary OpenShell delivery can expose a placeholder such as `OPENAI_API_KEY`. A native repository session file contains a usable session bearer. A source ID alone grants no access. |
| Have a child or sibling process make the approved read. | The sender accepts a bodyless `GET /repos/acme/widgets` from any process in the admitted execution if current checks pass. The child can read the approved result. The grant says nothing about which command a human intended to run.                                                                                                        |
| Create a pull request or read another repository.       | The metadata adapter checks the method, origin, path, headers and body against the route for the grant. It refuses `POST /repos/acme/widgets/pulls` and `GET /repos/acme/tools` before selecting material.                                                                                                                                    |
| Obtain more data through the approved GET.              | The sender holds the complete response. On a valid response the adapter checks the numeric repository ID and name, then returns only `id` and the admitted `full_name`. If the provider redirects, returns ambiguous JSON or reports a different ID, the sender withholds the response.                                                       |

The credential-free metadata profile applies the same request and response rules
with zero credential reads. The separately approved installation-wide GitHub
profile has a larger scope. GitHub installation membership and permissions bound
that access, and OCE supplies no repository ref allowlist for it.
[Metadata adapter](../../../apps/controller/src/drivers/egress-proxy/github-metadata.ts) ·
[Installation scope](../../guides/credential-proxy.md) ·
[Direct Harness credential exceptions](runtime-isolation.md#temporary-runtime-credential-exceptions)

## What stops another execution or a direct connection?

The protected exchange binds the authenticated sender, Sandbox, running
installation and original receiving connection to the captured request. A
copied handle cannot authorize a second execution of the same Agent or redirect
the first execution's response. If the recipient disappears, the sender must
withhold the response. The provider may already have received the request.
[Protected request flow](../../flows/credential-source-egress.md)

The installed Sandbox and its network controls must force provider traffic
through the enforcing sender. A process with another route can bypass its
checks, including on requests that need no credential. Proxy environment
settings, a startup hook or one successful request cannot establish that direct
connections are blocked. Stock OpenShell's observed-hook Git preview and its
refusal of repository-scoped protected writes are documented separately.
[OpenShell delivery profiles](../repository-credentials/protected-openshell-git.md) ·
[Installed custody and bypass checks](../../testing/protected-repository-custody.md#qualify-installed-custody)

## What happens when access changes?

OCC checks the current binding, execution, installation and permission before
material access and again before releasing a send permit. To withdraw the walkthrough's
metadata read, withdraw the bound credential source from the Agent's running
revision. If withdrawal occurs between those checks, OCC denies the send. If renewal
replaced the selected token, the old version fails its check. A request already
authorized can still reach the provider. A lost acknowledgment leaves the
attempt for reconciliation. Repeating a possible write can apply it twice.
[Send authorization](../../../packages/occ/src/credential-proxy.ts) ·
[Withdrawal](../credential-sources/withdrawal.md)

Git access through `repositoryBindings` has two additional limits. Repository
approval can be standing or time-limited, and the execution's repository session
has its own deadline. Both Git and the prepared metadata source also enforce a
local safe-use cutoff for the token. GitHub sets the token's expiry. Removing
Git approval can deny a Git request while the token still works at GitHub.
OCC denial, observed removal of the installed route and provider revocation or
expiry are separate events.
[Token Service lifecycle](../repository-credentials.md#token-service-lifecycle)

In the controlled withdrawal example, removing binding A preserves binding B.
After B is withdrawn, OCC denies B while the peer can still return 200 pending
policy application. After application and restart, the peer returns 403 for both
routes and the stored plan has no routes. This source check illustrates why an
acknowledgment alone cannot establish installed enforcement.
[Withdrawal example](../../../tests/integration/credential-proxy-withdrawal.test.ts) ·
[Installed qualification](../../testing/protected-repository-custody.md)

## Who remains trusted?

The sender receives usable credential headers and sees the provider response.
The issuer owner can use the signing key to request tokens. An administrator
who can change the sender, its trust roots or the enforced network policy can
change where requests go. A bearer copied on the trusted side can be used
within its own scope and lifetime. Withdrawal cannot retract data already
released to a workload.
[Credential custody](../credential-sources.md) ·
[OpenShell administrative access](../drivers/openshell-credential-gateway.md#trust-requirements)

[RFC-0023](../../../specs/rfcs/0023-egress-proxy-credential-lifecycle/index.md)
describes the proposed design. OCC and the adapter implement the request checks
above. Evidence for an installed build must cover its specific profile, sender
and transport. A controlled origin can show what reached that peer. A claim
about live GitHub behavior requires observation at GitHub.

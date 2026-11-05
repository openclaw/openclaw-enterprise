---
rfc: index.md
---

# Online request authorization with stock OpenShell

**Promise:** Before a managed HTTPS request proceeds, OpenShell must obtain a current allow
decision from OCE. An operator can withdraw access while the Agent is running and the
provider credential is still valid. We cannot recall a request that already passed the check.

## How it works

1. **Admit the execution.** Select online authorization explicitly; existing exact-dispatch
   admissions keep their meaning. Before releasing protected work, establish that this
   sandbox must use the authorizer, cannot bypass it, and has exactly the admitted endpoint
   and credential binding. Dedicate a never-reused sandbox identity to one execution, disable
   restart, and prevent stop/start or replacement under the same admitted authority.
   A missing authorizer is not the same as a configured authorizer that is unavailable.
   If we cannot establish the required enforcement on a release, refuse the protected launch.
   Stock OpenShell binds credentials to an endpoint, not permanently to a middleware service.
   OCE must control the workspace, policy, provider attachments and registration; a tenant
   cannot also attach that provider to another sandbox. Keep the request-binding manifest
   immutable across replicas. Change those inputs by stopping the old execution and admitting
   a new one. A deployment setting alone is not proof of that isolation.
2. **Install the credential.** OCE provisions the usable credential to OpenShell, never to
   the workload. Keep signing keys and refresh custody with the selected lifecycle owner.
   Saving an update is not evidence that the supervisor applied it.
3. **Authorize each request.** Use OpenShell's HTTP request middleware, before credential
   injection, with failure closed. Verify the gateway, audience and signed supervisor
   sandbox identity; bind it to one current OCE execution. The signed sandbox identity does
   not distinguish supervisor instances, including a replacement under the same sandbox ID.
   Evaluate the actual operation and current grant without caching allows. No later
   middleware may broaden what was approved. Deny unknown execution, operation or authority.
4. **Let OpenShell send.** On allow, its trusted supervisor selects the bound credential
   and handles the exchange. Record an authorization decision, not a claim of provider
   contact, delivery or successful completion. Start with explicitly supported, inspected
   HTTPS operations; do not imply Git transport, WebSockets or generic proxy coverage.

## Release requirements for mandatory online authorization

**OpenShell v0.1.4 is NOT QUALIFIED.** A fail-closed policy for an unavailable request service
does not prove that the request service is mandatory and invoked. Require the exact request
binding and exclusive control of later policy and registration changes. A future release check
could use an authorizer-generated challenge denial; that check is not implemented.

Nor does a reported `https` scheme prove encrypted transport. [Upstream issue and proposed
fix](https://github.com/NVIDIA/OpenShell/pull/4397) describe plaintext HTTP in a CONNECT
tunnel reported as HTTPS. A managed credential must never depend on that field alone for
transport security. A later stock release that accurately reports the scheme, or an
independently enforced trusted TLS guard with no direct route, could satisfy this gate after
qualification. If encrypted transport cannot be verified, refuse release.

OCE must also enforce one never-reused sandbox identity per execution. Disable restart,
strictly verify that policy when adopting a sandbox, and prevent stop/start or replacement
under the prior execution's grant. If these lifecycle controls cannot be established, refuse
release.

## Preview the configured request hook

An isolated team installation may explicitly offer _request hook observed_ before its
OpenShell release can make that hook mandatory. Admit this as a distinct choice, off by
default; never substitute it for mandatory online authorization or exact dispatch. Keep
verified TLS, no direct route, a never-reused sandbox and an exclusive credential recipient.
The team accepts the entire repository and permission scope of its GitHub App installation;
standing approval is a separate decision.

Only the operator may change the gateway, supervisor, authorizer, policy or provider. If
the operator replaces the authorizer with a response-only service, OpenShell can send the
request and credential without asking OCE. Before a planned change, close new admissions,
stop the old sender, and have the credential owner retire its token or preserve an unknown
outcome. Closing OCE admission alone cannot recall a credential already installed.

Qualify the stock release at a controlled origin: an allowed request arrives, and a fresh
request denied by OCE sends no HTTP bytes. At each new execution, with only harmless
bootstrap material installed, correlate a fresh challenge denial at OCE and at the actual
sender. Bind that observation to the release, execution, effective policy and recipient.
When replacing bootstrap material reloads policy, verify the resulting recipient and policy
before releasing user work. If that check fails, keep work closed and retire material that
may already be installed. Neither observation can force the next request to consult OCE.
Qualify the mandatory profile separately; never relabel a preview receipt as stronger evidence.

## Known gaps and what would close them

| Online authorization accepts | Stronger guarantee |
| --- | --- |
| The supervisor already holds usable provider material. Its signed identity is a reusable bearer, not proof bound to this request channel. | Resolve authorized material on demand; bind execution, channel and reply recipient. |
| The final check and send can race with withdrawal. We do not identify the exact credential version sent or interrupt a send that already won. | Bind selected material and operation to a short-lived, single-use send permit. Even this cannot undo a provider action. |
| An allow is not proof of one dispatch or of a safe response. Do not retry an ambiguous operation automatically. | Record the send attempt durably, preserve uncertainty and gate the full response before release. |

First qualify a released OpenShell without patches. If the gap is proving that an authorizer
is mandatory and applied, ask upstream for that narrow capability. Do not paper over a
missing enforcement boundary with a successful request or a configuration write.

## Release test

From a clean OCE checkout, use the published OpenShell image, an ordinary client and a
controlled HTTPS origin. Prove one allowed request; then leave the credential valid,
withdraw only the OCE grant, and observe refusal with no new origin request. Also test an
authorization outage, omitted middleware, a service advertising only a response binding,
attempts by a tenant to remove the policy or reuse the provider, plaintext in a CONNECT
tunnel, direct and uninspected routes, and attempted restart, stop/start or replacement under
the prior execution's grant. Report which release and which
operations passed; unsupported paths remain unavailable.

[Upstream request hook](https://github.com/NVIDIA/OpenShell/blob/v0.1.4/docs/extensibility/supervisor-middleware/operations.mdx)
· [Failure and update behavior](https://github.com/NVIDIA/OpenShell/blob/v0.1.4/docs/extensibility/supervisor-middleware/configure.mdx)
· [Extension authentication](https://github.com/NVIDIA/OpenShell/blob/v0.1.4/docs/extensibility/overview.mdx)

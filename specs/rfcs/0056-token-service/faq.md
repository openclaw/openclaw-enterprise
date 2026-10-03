---
rfc: index.md
---

# Token Service FAQ: OpenShell overlap and composition

This FAQ accompanies [RFC-0056](index.md). The decision is to keep one OCC Token
Service implementation with pluggable TokenDrivers. OpenShell is not a
replaceable backend for that service. OCE must manage the lifecycle of
platform-minted credentials, including repository tokens; OpenShell may directly
manage user-supplied credentials. OCC supplying platform-minted credentials to
OpenShell is an integration direction, not a delivered feature of this RFC.

## What overlaps with OpenShell?

Both systems keep upstream provider credentials away from Agent processes and
manage their lifetime. The OCC Agent does receive a usable broker bearer: its
possessor can authenticate to the repository gateway within current grants. It
is not an OpenShell credential placeholder. OpenShell providers associate
credentials with Sandbox access policy; its proxy resolves credential
placeholders for allowed requests. OpenShell also
supports provider refresh, including storing OAuth refresh material at its
gateway and replacing access tokens before expiry. See its
[provider documentation](https://github.com/NVIDIA/OpenShell/blob/ec49209da25be39840742df29b64ec694d159c2f/docs/how-it-works/providers/overview.mdx)
and [OAuth refresh example](https://github.com/NVIDIA/OpenShell/blob/ec49209da25be39840742df29b64ec694d159c2f/docs/tutorials/microsoft-graph-provider-refresh.mdx).

The proposed OCC Token Service owns issuance through TokenDrivers, lease and
cleanup accounting, and authorization against OCC Agent lifecycle and admitted
grants. Its first caller is the repository gateway serving Git and `gh`.
OpenShell owns Sandbox-side credential injection and egress enforcement. Similar
credential-lifetime mechanisms do not make their authorization or lifecycle
contracts interchangeable.

## Can OpenShell replace the OCC token broker backend?

No. This RFC does not introduce a selectable broker backend or an OpenShell
implementation of the OCC lease engine. TokenDrivers extend upstream issuance
and retirement; they do not replace OCC admission checks, bearer verification,
lease state, or recovery accounting.

A backend abstraction would need to translate those contracts into OpenShell
provider, Workspace, and Sandbox lifecycles and reconcile two systems' failures.
We do not need that complexity for the selected integration choices. The
existing OCC OpenShell Backend, which groups Sandbox and Credential Gateway
Drivers, is a separate platform concept; this decision does not remove it.

## How can an OpenShell deployment manage credentials?

Ownership depends on the credential source:

| Credential source                                        | OCC responsibility                                                                                                            | OpenShell responsibility                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| User-supplied credentials managed directly by OpenShell  | These credentials do not use the OCC token broker. Other OCC platform capabilities can still be used.                         | Configure providers and credential sources, own refresh where configured, and enforce Sandbox access and injection.         |
| Platform-minted credentials, including repository tokens | Own authorization, issuance, renewal, and cleanup. A future authenticated handoff may supply credentials to OpenShell itself. | Receive supplied credentials as a trusted service, expose placeholders to the Agent, and enforce provider policy at egress. |

Platform-minted credentials must not fall back to OpenShell-owned issuance.
Until the handoff exists, keep repository access through the OCC repository
gateway. The proposed handoff expands upstream-token custody to OpenShell, not
to the Agent. OCC's memory-only storage and broker revocation guarantees cannot
automatically be claimed for OpenShell's copy: revoking an OCC bearer alone does
not invalidate a credential already supplied to OpenShell.

The handoff must define recipient authentication, Namespace/Workspace ownership,
allowed credential scope, replacement, expiry, and withdrawal. It is separate
from the Agent bearer interface and does not create a general raw-token API.
First delivery keeps upstream tokens within the OCC service; the trusted-service
handoff requires a follow-up contract and implementation.

## Which system refreshes the token when both are used?

For platform-minted credentials, OCC owns issuer acquisition and refresh,
authorization, leases, and cleanup. OpenShell may schedule requests for replacement
credentials from OCC and cache the supplied result for injection. That delivery
loop must not independently refresh with the upstream issuer or bypass OCC's
current grants. An external-token-service refresh strategy is one possible
integration; it would not replace the OCC lifecycle engine.

Pushing ordinary provider updates alone does not prove seamless renewal.
OpenShell's [static update behavior](https://github.com/NVIDIA/OpenShell/blob/ec49209da25be39840742df29b64ec694d159c2f/docs/how-it-works/providers/overview.mdx#manage-providers)
leaves existing processes holding revision-scoped references to the old value.
The future handoff must prove replacement without restarting running Agents,
expiry handling, and withdrawal of cached credentials and retained references.
The protocol and choice of push versus pull remain follow-up work.

When OpenShell owns a user-supplied OAuth refresh grant, OpenShell owns its
access-token refresh and recovery. Supplying bootstrap material is a separate
role from leasing each resulting access token through OCC. The current RFC
neither adds persistent OAuth refresh-token custody nor implements that bootstrap
handoff.

## Does OCC already supply secrets to OpenShell?

The existing [OpenShell Credential Gateway](../../../docs/reference/drivers/openshell-credential-gateway.md)
registers and updates credential sources as OpenShell providers; its supported
catalog currently contains OpenAI API keys. This demonstrates the direction of
composition. It does not implement generic Token Service leases or their
renewal and withdrawal through OpenShell, and it does not establish production
support for the OpenShell execution path. The reference owns those limits.

Keep this integration with the existing CredentialGatewayDriver and OpenShell
Backend owners. Extend their contracts where needed for a concrete consumer;
do not add a parallel broker-backend plugin framework.

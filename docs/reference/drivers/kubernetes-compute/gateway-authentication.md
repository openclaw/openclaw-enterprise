# Kubernetes Gateway authentication

Compute renders `gateway.auth.mode: trusted-proxy` and
`trustedProxy.userHeader: x-occ-identity`; Configurations may omit these fields
or set them to those exact values. Omission defaults `allowUsers` to
`["occ-workspace-files"]` and its `identityScopes` grant to `["operator.admin"]`.
Human policies must retain the machine identity and its exact `["operator.admin"]` grant.
Empty allowlists and nonstring, blank, untrimmed or non-printable-ASCII identities
fail closed, as do JavaScript object property names such as `constructor`. So do duplicates and case variants of `occ-workspace-files` or of an
email-style identity: OpenClaw matches `identityScopes` case-insensitively for
identities containing `@`, so such variants would share one grant.

> **Warning: trusted teammates only.** Shared human access is opt-in for teammates
> trusted with the Agent's configured tools, credentials and workspace. Profiles
> provide attribution, and Gateway roles restrict operations; neither provides
> per-person execution or data isolation. Participants share the Agent's sandbox
> and its OpenShell policy when OpenShell is configured. Use separate Agents and
> sandboxes when people must not share that authority or data. See OpenClaw's
> [multi-user trust boundary](https://docs.openclaw.ai/concepts/multi-user#trust-boundary).
>
> **Access withdrawal is not execution cancellation.** Already accepted work,
> including background commands, may continue after a role change or
> Gateway-access removal. This feature does not guarantee cancellation before
> further effects. Remove the person from both `allowUsers` and `identityScopes`;
> identity grants can also authorize linked channel identities. Withdrawal does
> not delete saved personal model accounts or clear existing sessions' account
> selections. Revoke credentials with the provider when their use must stop.
>
> **IdP withdrawal has no OCE revocation deadline.** When identity-provider account
> disablement or group-membership removal blocks new Gateway admission depends
> on the external ingress's token/session lifetimes and revalidation policy.
> Operators must configure and verify that policy; this feature supplies no
> bounded identity-provider revocation guarantee.

Compute renders `gateway.trustedProxies` from `network.gatewayTrustedProxyCidrs`
and `gateway.allowRealIpFallback: true`; CIDR order may differ.
Conflicting/unsupported settings return `409 RESOURCE_CONFLICT` with setting/requirement,
never values. Invalid `allowUsers` instead produces fixed provisioning `409`
text plus an API-log reason, or deployment-preparation `DEPENDENCY_UNAVAILABLE`
plus `worker.compute-prepare-failed`. `trustedProxy.allowLoopback` must be omitted
or false; local verification uses the separate password.

```json
{
  "gateway": {
    "auth": {
      "trustedProxy": {
        "allowUsers": ["occ-workspace-files", "oidc:member-01"]
      },
      "identityScopes": {
        "occ-workspace-files": ["operator.admin"],
        "oidc:member-01": ["operator.read", "operator.write"]
      }
    }
  }
}
```

## Human ingress

Human ingress is operator-managed; OCE deploys neither the route nor its
identity provider. Humans need no OCE account. The ingress must authenticate
humans, authorize access to the exact Gateway, and overwrite client-supplied
identity and authority headers. Use stable, namespaced human identities, such
as an issuer-qualified OIDC subject. Reserve `occ-workspace-files` for OCC:
the human ingress must never emit that identity.

The ingress must also set `x-openclaw-scopes` on every request, HTTP and WebSocket
upgrade, to that person's granted scopes, replacing any client value. To grant none,
send a value that is not a scope, such as `none`: many proxies drop empty
headers. Native HTTP APIs, such as `/tools/invoke` and `/sessions/<key>/kill`,
ignore `identityScopes`: without the header, OpenClaw gives a trusted-proxy request
its default operator scopes, including `operator.admin`, narrowed only by native
role ceilings. So whenever `allowUsers` admits a human, Compute adds
`x-openclaw-scopes` to `trustedProxy.requiredHeaders` (operator entries are kept;
they must be nonblank, trimmed names, and on routed Agents may not name a header
the route removes), and the Gateway refuses any trusted-proxy request without it:
`401` on HTTP, and a WebSocket connect falls back to device authentication. The
requirement proves the header is present, not who set it: an ingress that forwards
a client's `x-openclaw-scopes` still lets a person claim `operator.admin` on those
APIs. The operator HTTPRoute sets the header to `operator.admin` for the machine
identity. On WebSocket upgrades the header caps the union of device and identity
grants.

Private routing can remain enabled. Its operator HTTPRoute always replaces
`x-occ-identity` with the machine identity, so human traffic needs a separate
identity-preserving route to the Gateway Service. With a separate proxy, the
operator must add an exact-peer NetworkPolicy permitting that proxy to reach
the selected Agent's Gateway port, configure proxy egress, include its actual
socket-source addresses in `network.gatewayTrustedProxyCidrs`, and add the
human UI origin to `gateway.controlUi.allowedOrigins`. Kubernetes ingress
policies are additive; the operator's policy permits this path alongside
Compute's Envoy policy. Keep `network.gatewayClients` omitted in routed mode.
An OpenShift Route with Keycloak/OAuth2 Proxy is one external implementation;
OCE does not provision or reconcile it. The existing OCC route retains machine
identity, which native roles must allow to administer.

## Device grants

Human allowlists forbid `operator.admin` in `deviceAutoApprove.scopes`, including
surrounding whitespace. Device grants are unioned with `identityScopes`; grant
human admins explicitly. Identity grant keys must be nonblank, trimmed and in
`allowUsers` (omission admits only the machine identity). Grants must be arrays
of scopes supported by the pinned Gateway; unknown or padded scope names fail
admission before rollout. Machine-only admin auto-approval remains valid.

With auto-approval enabled, device scopes are a shared grant, not a per-human cap.
Omitting them uses OpenClaw's defaults: `operator.read`, `operator.write`,
`operator.approvals` and `operator.questions`. Explicit read/write device scopes
can likewise widen a narrower identity grant. Set device scopes explicitly for
the least-privileged admitted human; per-identity grants cannot subtract them, but
the ingress's per-person `x-openclaw-scopes` cap can. A paired device keeps its grant under any
admitted identity that presents its key, and narrowing a person's grant does not
narrow their devices. Admitting humans does not narrow devices already paired
with admin grants, for example under earlier machine-only admin auto-approval:
review and revoke those pairings first.

When native configuration is writable, any `operator.admin` holder, human or
machine, can change `allowUsers`, `identityScopes` and device auto-approval in
the running Gateway, bypassing these checks until the Pod is replaced. Grant
human admin only to people trusted to decide who else gets access.

## Listener and proxy trust

Compute renders `gateway.bind: lan` when it is omitted or `auto`, as native
container detection misses containerd on cgroup v2. Deployment/provisioning
refuse any other bind, `custom` unless `customBindHost` is `0.0.0.0`, and any
`gateway.tailscale.mode` but `off`. Accepted `lan` and `custom` binds listen on
IPv4 `0.0.0.0`, so Gateways need an IPv4 Pod address.

An optional [loopback password](storage-and-credentials.md#runtime-credentials)
supports operator verification.
Kubernetes private status-port `GET /readyz` returns empty `200`/`503`, retaining
readiness gates; Gateway probes HTTP. `gateway.tls.enabled: true` is refused
before an Agent revision is created. Envoy terminates TLS. Docker/SSH
retain managed-password defaults and explicit trusted-proxy HTTP.

Configured CIDRs must contain the proxy's source addresses and exclude untrusted sources.
CIDRs do not authenticate a proxy: retain the exact Envoy NetworkPolicy peer, TLS verification, service-key
authentication, and identity/header sanitization.

## Related

- [Networking and isolation](networking-and-isolation.md)
- [Configure private Agent routing](../../../guides/deploy/workspace-routing.md#configure-native-gateway-authentication)

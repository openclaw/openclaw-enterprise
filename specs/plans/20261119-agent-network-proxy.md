---
rfc: ../rfcs/20261119-agent-network-proxy.md
---

# Implementation plan: Agent Gateway channel upstream proxy

- **ID:** RFC-20261119-agent-network-proxy
- **Delivery status:** In progress
- **Owner:** OCE Core and Kubernetes Compute
- **Authority:** [Proposed RFC](../rfcs/20261119-agent-network-proxy.md), submitted in [PR #6842](https://github.com/openclaw/openclaw-enterprise/pull/6842)
- **Source baseline:** `c25e2879e580e67cb787eb87327ea3ac03845093`

## Outcome and scope

An authorized user can save an upstream proxy for one Agent's permitted
Gateway channel connections. A deployment uses the selection saved in its Agent
revision. The Gateway continues to connect to its assigned Envoy listener.
The [RFC acceptance criteria](../rfcs/20261119-agent-network-proxy.md#acceptance-criteria)
define the required results. OCC, Harness, model, tool, OpenShell, and ordinary
HTTP forwarding routes are outside this change.

## Input decisions

### Agent and Secret

Use `networkProxy: { url, credentialSecretId? }` on Agent create, update,
read, and revision projections. An omitted update leaves the draft unchanged;
`null` clears it. The URL contains an explicit `http://` or `https://`
scheme, hostname or IP address, and optional port. Use port 80 or 443 when
omitted. Reject user information, query, fragment, and paths other than
`/`. Return a generic error without the submitted URL when parsing fails.
Never accept a credential-bearing URL as ordinary Agent input.

`credentialSecretId` selects an existing OCE Secret in the Agent's Namespace.
The Secret value is the complete `Proxy-Authorization` header value in
`Basic <base64(username:password)>` form. Reject malformed values and control
characters without returning their content. The Console uses the existing
Secret selector; it does not accept a password in the URL field. Caller and
Agent-principal grants must authorize the exact Secret at admission and worker
dispatch. Agent and revision rows contain only the normalized endpoint and
Secret ID. PostgreSQL constraints enforce the persisted shape.

### Installation reachability and trust

Add matching Installation Compute and Helm inputs under
`channelEgress.upstreamProxies`. Each entry contains a normalized endpoint
URL and its explicit IPv4 `/32` addresses. The endpoint URL fixes the port.
The operator supplies this installation network configuration through the
existing Installation procedure; Agent update authority cannot change it.
Require exact agreement between Installation and chart inputs before admission.
Reject metadata addresses and cluster infrastructure addresses. A private VPC
proxy address is permitted only through its endpoint's exact address and port.
Do not change the fleet's general private, metadata, Pod, Service, or node
exclusions.

Resolve endpoint DNS and require every selected address to belong to the saved
entry. Use only those addresses for the proxy cluster and NetworkPolicy grant.
Refuse an address change until the operator updates the Installation entry;
never fall back to a direct channel connection. For HTTPS, use the endpoint
hostname for SNI and certificate verification. Reuse the installation's public
CA Secret pattern: optional chart inputs
`channelEgress.proxyTrust.caSecretName` and `caKey` select a PEM bundle of
public CA certificates, with the same reference in Compute configuration.
The Secret resides in the Envoy namespace and contains the complete trust
bundle, including public roots and the required private CA. Mount it read-only
in the Envoy fleet through EnvoyProxy and reference the mounted file from TLS
validation. Without this input, use the Envoy image's public root bundle. Do
not mount either bundle into Gateway or Harness Pods. A missing or invalid
bundle fails installation or admission.

## Owners and implementation order

1. **Qualify the installed path before runtime changes.** Use Envoy Gateway
   `v1.6.7`, the chart's pinned Envoy image, and the current OpenClaw pin.
   Prove that a binding-owned Kubernetes Secret can reach Envoy through SDS
   without credential bytes entering an EnvoyPatchPolicy, ConfigMap, inspection
   response, access log, controller log, or audit event. Prove HTTP and HTTPS
   CONNECT chaining, private CA verification, header isolation, rejection,
   outage, streaming, and WebSockets. Check that the actual patched listener
   retains the Secret reference and the worker can verify installed enforcement.
   Do not ship a plaintext header in xDS or add a credential service to bypass
   a failed qualification.
2. **Core and State.** Extend
   [Agent routes](../../apps/controller/src/http/agents.ts),
   [draft operations](../../packages/occ/src/agent-drafts.ts),
   revision admission, worker dispatch, PostgreSQL persistence, and public
   projections. Reuse exact-Agent and Secret authorization. Save the revision
   and queued deployment atomically. Reject unsupported Compute configurations
   before saving or deploying the selection.
3. **Kubernetes Compute.** Extend its reviewed contract and
   [channel binding owner](../../apps/controller/src/drivers/compute/kubernetes/channel-egress.ts).
   Include endpoint, Secret identity, trust identity, and scoped addresses in
   the binding configuration identity. On the proxy route, authorize CONNECT
   authority and port before credential injection, then forward CONNECT to the
   selected proxy cluster. Keep provider TLS inside the tunnel. Do not apply
   the direct route's final-IP check to a proxy-resolved destination or claim
   that it still applies. Install only the selected proxy's egress grant.
   When upstream proxies are configured, Helm creates one blank Kubernetes
   Secret, credential HTTPRouteFilter, and deny-only HTTPRoute for each existing
   listener slot in the Gateway configuration namespace. The manifest omits
   Secret data and binding annotations. Give the
   worker only `get` and `update` on those exact Secret names; never grant it
   unrestricted Secret access in the OCC release namespace. The worker fills
   the assigned slot's `credential` key and records the binding identity with
   a resource-version check. Envoy Gateway becomes a trusted credential reader.
   The fixed slot route matches a reserved path and returns 503 through the
   existing deny filter; attach no forwarding backend. Its filter and SDS name
   belong to that listener slot. The worker needs no route or filter mutation
   permission. Include the source Secret UID and resource version in the binding
   identity. Refuse a retry if that material version changed; a new deployment
   can select the new version.
   Activate the injector in that listener's router upstream filter chain,
   after CONNECT and proxy-address enforcement and before the upstream codec;
   Envoy Gateway's generated route filter is disabled until a route enables it.
   Overwrite any downstream `Proxy-Authorization` header. During retirement,
   install deny and wait for the drain gauge to reach zero. Empty the slot,
   require the controller to reject the now-empty credential route, and require
   the old SDS name to disappear while the static route and filter remain. Only then
   mark the blank slot idle and release the listener port.
   Restrict inspection to exact listener and cluster resource queries and
   `dynamic_active_secrets&mask=name`. Reject full dumps, unmasked Secret
   queries, and extra or duplicate query parameters.
   Preserve capacity limits, retries, stop, deletion, and port-release fences.
4. **Console and documentation.** Add the URL and Secret selection to the
   Agent editor and deployment summary, with validation, loading, permission,
   and error states. Update Storybook and capture screenshots and a walkthrough.
   As behavior ships, update Agent, Compute, channel-egress, security, API,
   permissions, database, and configuration owners and the
   [channel egress flow](../../docs/flows/channel-egress.md). Update the
   architecture's egress trust claim only when proxy routing is implemented.

## Verification

Use the normal Agent QA journey with real PostgreSQL, an enforcing disposable
k3d cluster, shipped Gateway and Harness images, controlled HTTP/HTTPS proxies,
and a real Gateway channel connection. Extend
[the QA matrix](../../tests/integration/qa-matrix-real.test.mjs) and
[channel egress integration](../../tests/integration/channel-egress-kubernetes-real.test.ts)
through the real caller; register new cases in CI.

| Required outcome           | Evidence and remaining check                                                                                                                | Result  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| AC-1 routing and admission | Published-runtime no-channel Agent and hosted controlled dedicated direct/proxied routes passed; live Slack routing remains.                | Partial |
| AC-2 compatibility         | Controlled HTTP/HTTPS, private CA, bad TLS and real SOCKS/PAC refusal passed; published-runtime live channel compatibility remains.         | Partial |
| AC-3 isolation             | Controlled two-Agent isolation, pinned authority denials and enforcing-cluster endpoint qualification passed; live two-Agent proof remains. | Partial |
| AC-4 lifecycle             | Controlled revision edit/clear, 407 recovery, real-cluster reuse/fencing and deterministic drain passed; live lifecycle proof remains.      | Partial |
| AC-5 scope                 | Hosted controlled OCC validation/directory, dedicated Harness routing and no-channel no-grant model proof passed; live scope proof remains. | Partial |
| AC-6 Secrets and UI        | Hosted controlled Gateway/audit/inspection/log containment and rebuilt Console media passed; live channel containment remains.              | Partial |

## Qualification and delivery record

- The RFC is Proposed and retains its human-review/manual-merge hold.
  [Implementation PR #6856](https://github.com/openclaw/openclaw-enterprise/pull/6856)
  is open; its reviewed routing fix is at `e66d1168`. Hosted controlled proof
  passed; live Slack acceptance remains pending. Submission and implementation
  do not authorize a merge.
- Main pins OpenClaw source `cf0b3bb0f8efd6e8f230f9e1879b9fb871db96ef`.
  The exact submitted RFC records the earlier pin `82b682c…`; qualification
  must use the current shipped source and immutable runtime images.
- The pinned Envoy image
  `envoyproxy/envoy@sha256:ccb37e93d8274a525fe00d67287716dbe3d58bc4237d7627af9e64fae0fd25c8`
  reports Envoy 1.39.4, commit `72315c132d462e5126e492ab2a71057565dbc87a`.
  A standalone controlled HTTP proxy probe passed CONNECT target forwarding,
  binding-specific Basic credential injection from a file SDS Secret, and
  bidirectional tunnel bytes. The credential was absent from Envoy
  `/config_dump` and warning logs. This was a standalone Envoy probe, not
  Envoy Gateway, Kubernetes, OCE, or AC evidence.
- A second standalone probe used an HTTPS proxy with a generated private CA.
  The trusted certificate passed CONNECT, authentication, and tunnel bytes.
  An untrusted certificate and a wrong hostname each returned 503 before
  credential delivery. Inspection and warning logs contained no credential.
  This does not prove installation CA delivery.
- Envoy documents the [generic credential injector](https://www.envoyproxy.io/docs/envoy/v1.39.4/api-v3/extensions/http/injected_credentials/generic/v3/generic.proto)
  with an unknown security posture and limited production use. Envoy Gateway
  [v1.6 credential injection](https://gateway.envoyproxy.io/v1.6/tasks/security/credential-injection/)
  uses a Kubernetes Secret. Qualification must assess those limits for this
  binding and trust boundary.
- In a disposable k3d cluster, Envoy Gateway v1.6.7 generated an ADS SDS
  reference from a Kubernetes Secret and HTTPRouteFilter. Its generated
  injector had `disabled: true`; copying it unchanged forwarded a supplied
  authorization header. Activating the injector in the binding's patched
  listener corrected this failure. A further installed probe placed the
  injector in the router's upstream HTTP filter chain, before the upstream
  codec. This is the selected placement: the listener authorizes CONNECT
  first, and the injector runs only for the selected proxy cluster. With an
  egress NetworkPolicy scoped to the
  controlled proxy's private `/32` and port, CONNECT returned 200, tunnel bytes
  passed, the selected credential replaced the supplied header, forbidden
  authority returned 404, and proxy outage returned 503. Credential bytes were
  absent from the patch, Envoy inspection, Envoy logs, and controller logs.
  The cluster was removed. This proves an installed Envoy path, not OCE
  admission, audit, revision lifecycle, or a real Gateway channel connection.
- A deny-only route with credential injection also generated ADS/SDS without a
  forwarding backend. The patched listener then completed authenticated
  CONNECT and tunnel bytes through a private HTTPS proxy, using a CA read from
  a Kubernetes Secret. A second installed probe mounted the installation CA
  Secret read-only through EnvoyProxy and used its filename for TLS validation;
  authenticated CONNECT and tunnel bytes passed. Forbidden authority and outage
  remained closed.
- Full inspection returned no credential bytes, but it exposed the SDS
  resource's 64-character delta version. Envoy Gateway's
  [go-control-plane dependency](https://github.com/envoyproxy/go-control-plane/blob/v0.14.0/pkg/cache/v3/resource.go)
  computes that version from deterministic serialized resource bytes. The
  selected exact-path inspection rules passed listener, cluster, and
  names-only SDS queries without that hash; full, unmasked, and duplicate-query
  requests returned 404.
- Envoy Gateway v1.6.7 rejected a cross-namespace credential Secret reference
  even with a ReferenceGrant. A Helm 3.19.2 probe instead precreated a blank
  slot Secret. Upgrade preserved worker-written credential data and binding
  annotation while the release manifest contained no credential. Exact-name
  RBAC allowed slot `get` and denied unrelated Secret `get`, Secret creation,
  and slot deletion. With the chart's drain settings and gauge at zero,
  emptying the slot made the controller reject the credential route and removed
  the old active SDS resource. A Helm-precreated static route/filter remained
  in place. Refilling the slot then completed CONNECT with the new credential
  and without the old credential; outage returned 503.
- The published stable Gateway runtime connected in Socket Mode to a controlled
  Slack-compatible provider using synthetic tokens and `SLACK_API_URL`. The
  provider recorded `auth.test`, `apps.connections.open`, and a WebSocket
  handshake. Both CONNECT requests passed through the assigned Envoy listener
  and authenticated upstream proxy. This proves genuine Gateway plugin and
  tunnel execution against a stand-in. It does not prove Slack or normal OCE
  Agent admission: OCE's installed Channel Driver permits Slack-owned hosts.
- A local image built from the exact current source pin has image ID
  `sha256:3acacc337adcb9be49ec55408997fa3299b289e4b16918011ed358faf5660c69`,
  OpenClaw 2026.11.5, proxyline 0.4.1, and matching packaged provenance. Its
  Gateway completed the same controlled Socket Mode connection: two
  authenticated CONNECT requests, both API calls, and one WebSocket handshake.
  The Gateway could not read the proxy Secret file, and its logs contained no
  proxy credential. This satisfies the pre-implementation Gateway and Envoy
  qualification for the selected design. It is a local build and stand-in
  provider, not a published image or live Slack acceptance.
- The published `ghcr.io/openclaw/openclaw-enterprise-runtime:stable` index
  resolves to `sha256:6d0af87f6b2b803975cba47305bf69cd59aef69427290f0490da31f488855cb9`.
  Its OpenClaw package is 2026.10.8 and uses `@openclaw/proxyline` 0.4.0;
  current main's OpenClaw pin declares proxyline 0.4.1. Select a published
  immutable runtime pair that matches the intended compatibility target before
  claiming shipped-runtime qualification. A local build is not publication.
- Live Slack QA selects these scoped inputs:
  `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`,
  `OCC_TEST_SLACK_SENDER_BOT_TOKEN`, and `OCC_TEST_SLACK_CHANNEL_ID`.
  Read-only identity, membership, and history checks passed for a dedicated QA
  app, distinct driver, and non-DM channel. QA requires an approved working Codex
  PAT and exclusive fixture lease. Exact posts are conditionally authorized; no
  QA messages were posted. An isolated sequential Slack hello baseline passed,
  but Codex login failed before Slack configuration; no Gateway Socket Mode
  consumer started. OCC refused embedded channels, which require dedicated
  execution. Live Slack with the unmodified shipped runtime remains unverified.

- [Main-only publisher run 44955206942](https://github.com/openclaw/openclaw-enterprise/actions/runs/44955206942)
  succeeded for OCE main `e9abd346` and OpenClaw `cf0b3bb0`. Its runtime index is
  `ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:05247b40b16fd6f1154198d783f35b06c7313444858dc7603802e7f62365e2f8`
  (amd64 `sha256:6d2af2efbc2e0ceb8435e5dfe4bcb22b2dd38d09fd31c1374652d4094adb432e`;
  arm64 `sha256:6dd842b052b96ca419205d2b6fccdafb6ed95b9c9eb4a183a5d9b35e9b04ffd3`).
  Select the same runtime index for Gateway and Harness. This publication is
  from main; the implementation controller must still be built from PR source.
- The no-channel normal-Agent integration passed 1/1 with zero skips on an
  enforcing disposable k3d cluster and migrated limited-role PostgreSQL database.
  Gateway and Harness selected the published amd64 manifest
  `sha256:6d2af2efbc2e0ceb8435e5dfe4bcb22b2dd38d09fd31c1374652d4094adb432e`;
  the PR controller manifest was
  `sha256:00eae515400a293a9c6a835ea7734fd9ecefc7fdf8f6a7a5777713772bdd4850`.
  The test covered safe SOCKS5 and PAC refusal without draft mutation, exact
  Secret denial, actual enforcement outage and recovery, immutable revisions, an
  embedded `gpt-6-astra` turn, and absence of a channel grant or proxy contact.
  It did not exercise an enabled channel.
- The one-port drain conformance test passed 1/1 with zero skips. It uses the
  production Kubernetes Driver with an injected Envoy inspection response: gauge
  1 holds the slot in revoking state and refuses a new allocation without a
  write; gauge 0 permits retirement and same-port reuse. This is deterministic
  Driver conformance, not a real Envoy drain-timing measurement.

- [Hosted First Agent Smoke](https://github.com/openclaw/openclaw-enterprise/actions/runs/44966079230/job/137035493277) passed at `b937e52e7`. In 328 seconds, two dedicated Agents passed HTTP/HTTPS private CA, Socket Mode, policy denials, OCC/Harness isolation, 407 recovery, revision edit/clear, bad TLS, and credential containment. It used stand-in Slack/model providers and a checkout-derived runtime with an added stand-in CA; it did not qualify the unmodified shipped runtime.
- Credential-free enforcing-cluster qualification used the production Driver, a synthetic revision, and published arm64 runtime. The Envoy Pod reached only `172.18.0.5/32 TCP 38001`; unselected controls reached `38002` and non-node neighbor `.6:38001`. Unauthorized observations were zero; 19 UID/ID-checked resources were removed. This was not normal Agent or Slack proof.

- [Native arm64 container check](https://github.com/openclaw/openclaw-enterprise/actions/runs/44963429693) passed: artifact `14732406861`, native `linux/arm64`, source `f8fe9476850d5cee45759bbf36e0530b8e24435f`, manifest `sha256:b3ac8fd2a37680252e1190c743794a883a4759122b8714aa5b1ec2523cb5fab5`, config `sha256:e90e22472a3233798008822cefdec6f7cb7d139aeddb8e4db2710ff541e90601`. Repository verification rehashed the OCI graph.

## Manual Notes

## Changelog

- 2026-11-21 16:43: Record controlled, endpoint, and native arm64 qualification (authoring-run/01a1fbf1-03d5-7d21-af95-cdba37f77298 - 9e5d24b106bbbf8532cc276a1a09f98bf1cf0444).

- 2026-11-21: Record the published-runtime no-channel Agent proof and real SOCKS/PAC refusal checks (authoring-run/01a1fbf1-03d5-7d21-af95-cdba37f77298).

- 2026-11-21: Record the published runtime candidate and the dedicated-only channel admission boundary (authoring-run/01a1fbf1-03d5-7d21-af95-cdba37f77298).

- 2026-11-21 14:26: Record implementation PR, partial AC evidence, live fixture
  constraints, and publication boundary (authoring-run/01a1fbf1-03d5-7d21-af95-cdba37f77298 - 61ad9f42bcf90c723711443c3f616c7dc185d189).

- 2026-11-21 UTC: Create the implementation plan from main `c25e2879` and
  record the standalone Envoy probe.
- 2026-11-21 UTC: Settle deny-only SDS staging, upstream injection, mounted
  trust, and exact source-pinned Gateway qualification at `c25e2879`.
- 2026-11-21 UTC: Qualify exact-name Secret slots, retirement, and inspection
  queries that exclude credential-derived delta versions.
- 2026-11-21 UTC: Qualify static route/filter slots and safe credential reuse
  without new worker routing permissions.

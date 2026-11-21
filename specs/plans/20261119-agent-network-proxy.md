---
rfc: ../rfcs/20261119-agent-network-proxy.md
---

# Implementation plan: Agent Gateway channel upstream proxy

- **ID:** RFC-20261119-agent-network-proxy
- **Delivery status:** Planned
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
Combine that bundle with public roots for Envoy; do not mount it into Gateway
or Harness Pods. A missing or invalid bundle fails installation or admission.

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
   Stage one binding-owned Kubernetes Secret in the Gateway configuration
   namespace with key `credential`; Envoy Gateway becomes a trusted reader of
   that credential. Use a binding-specific Secret name and SDS reference.
   Activate the injector on the patched binding listener; Envoy Gateway's
   generated route filter is disabled until a route enables it.
   Overwrite any downstream `Proxy-Authorization` header. Remove the Secret
   only after the deny chain is installed and old tunnels have drained.
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

| Required outcome           | Real check                                                                                                                             | Result  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| AC-1 routing and admission | Agent deploy with and without proxy; observe Gateway, Envoy, proxy, and destination; unsupported Compute refusal                       | Not run |
| AC-2 compatibility         | Current shipped OpenClaw, HTTP/HTTPS authenticated proxy, private CA and bad certificate, streaming and WebSocket, SOCKS/PAC refusal   | Not run |
| AC-3 isolation             | Two Agents, distinct bindings and proxies, forbidden channel authority, direct egress, neighboring private address and metadata denial | Not run |
| AC-4 lifecycle             | Edit, clear, deploy, retry, retire, tunnel drain, capacity, outage and authentication failure without fallback                         | Not run |
| AC-5 scope                 | OCC Slack validation/directory route, unchanged Harness and internal transport, no-channel Agent without extra grant                   | Not run |
| AC-6 Secrets and UI        | Caller and Agent-principal denial; public reads, inspection, logs and audit; rebuilt Storybook screenshots and walkthrough             | Not run |

## Qualification and delivery record

- The RFC is Proposed. Submission does not establish acceptance or permission
  to merge. No implementation PR exists.
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
  listener corrected this failure. With an egress NetworkPolicy scoped to the
  controlled proxy's private `/32` and port, CONNECT returned 200, tunnel bytes
  passed, the selected credential replaced the supplied header, forbidden
  authority returned 404, and proxy outage returned 503. Credential bytes were
  absent from the patch, Envoy inspection, Envoy logs, and controller logs.
  The cluster was removed. This proves an installed Envoy path, not OCE
  admission, audit, revision lifecycle, or a real Gateway channel connection.
- Installation CA delivery, inspection through OCE, shipped Gateway
  compatibility, and the real Agent acceptance journey remain unqualified.
  Runtime implementation is gated on that evidence.
- The published `ghcr.io/openclaw/openclaw-enterprise-runtime:stable` index
  resolves to `sha256:6d0af87f6b2b803975cba47305bf69cd59aef69427290f0490da31f488855cb9`.
  Its OpenClaw package is 2026.10.8 and uses `@openclaw/proxyline` 0.4.0;
  current main's OpenClaw pin declares proxyline 0.4.1. Select a published
  immutable runtime pair that matches the intended compatibility target before
  claiming shipped-runtime qualification. A local build is not publication.
- The authorized live Slack QA inputs are unavailable on this DevBox:
  `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`,
  `OCC_TEST_SLACK_SENDER_BOT_TOKEN`, and `OCC_TEST_SLACK_CHANNEL_ID`.
  No local credential set is configured. The [Slack test guide](../../docs/testing/slack.md#slack)
  requires an authorized non-DM channel and distinct sender bot. Without those
  inputs, the real Gateway channel qualification and AC journey cannot run.

## Manual Notes

## Changelog

- 2026-11-21 UTC: Create the implementation plan from main `c25e2879` and
  record the standalone Envoy probe.

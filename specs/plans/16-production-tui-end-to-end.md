# Feature Spec: Production interactive TUI

**Date:** 2026-08-31
**Status:** Completed
**Implementation PR:** [Production interactive TUI #3](https://github.com/openclaw/openclaw-enterprise/pull/3)
**Owner:** Production deployment documentation and Kubernetes integration
**Source baseline:** `b43cc49c45fa6275e79985be0eabb517743c6a23`

## Problem and Decision

Prove that the existing production Helm installation can provision a Namespace,
embedded Agent and its gateway, then serve real conversations in the native
OpenClaw TUI. Extend [Deploy](../../docs/guides/deploy.md) with the production attach
procedure and add one live installation integration. Reuse production contracts
and the development TUI test helper; no new setup CLI or public API is required.

The development guide is a separate concurrent change. This specification adds
production Kubernetes proof without duplicating its Docker implementation.

## Scope

- Exercise the real Helm-installed production API, worker and PostgreSQL in an
  explicitly selected disposable local k3d cluster with enforcing NetworkPolicies.
- Provision through the authenticated OCC API and operator-owned tenant RBAC and
  Secrets; keep a final live setup attachable for interactive follow-up.
- Prove normal authentication, two replies in the same TUI, explicit exit,
  immutable revision cutover and allowed/denied network paths.
- Defer dedicated Codex walkthroughs, remote shared-cluster deployment, external
  messaging, host-installed TUI, one-command installers and new deletion APIs.

## Contract

### Installation and provisioning

Use the [production installation](../../docs/guides/deploy.md#production)
with actual digest-pinned controller and OpenClaw images, an isolated PostgreSQL
instance, separate migration/application roles, protected bootstrap PVC, and
normal Secure session cookies. The proof's operator HTTPS proxy terminates TLS
with a locally trusted certificate, selects an allowed API client and omits
forwarding headers rejected by the controller. Never disable TLS verification.

A Namespace creates tenant infrastructure; each Agent owns its combined embedded
gateway/Harness. Reuse existing [Kubernetes lifecycle contracts](../../docs/reference/drivers/kubernetes-compute.md).
Create Namespace, observe its exact backing namespace, install the three existing
tenant RoleBindings, and wait for `data.status === "ready"`. Create its native
Configuration and embedded Agent. An operator creates exact Agent-owned transport
and model Secrets, then sends a bodyless deploy request and waits for
`data.activeRevisionId` to equal the admitted revision. API envelopes are `{data,meta}`.
Poll with a deadline; stop on HTTP failure or failed/deleting Namespace state.

Use [createHarnessConfiguration](../../tests/helpers/harness-configuration.mjs) for
native `openai/<model>` / runtime `openclaw`. Set `agents.defaults.skipBootstrap`
to `true` for the connectivity demo so first-run identity setup does not replace
the requested test reply. Keep `${OPENCLAW_GATEWAY_TOKEN}`
literal and model credentials out of Configuration/revision snapshots. Existing
key environment supplies only the exact embedded gateway model Secret. Neither
API nor worker receives a model key. Use no service account resource for this proof.

### Attach and continue

Select exactly one Running, Ready gateway Pod in the verified tenant namespace
with labels `app.kubernetes.io/managed-by=openclaw-enterprise`,
`openclaw.dev/namespace=<Namespace ID>`, `openclaw.dev/agent=<Agent ID>` and
`openclaw.dev/workload-role=gateway`. Match
its mounted immutable gateway ConfigMap to the active revision: gateway Pod
revision labels do not identify a cutover. Reject absent or ambiguous matches.

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" exec -it "$GATEWAY_POD" -c gateway -- \
  env -u OPENAI_API_KEY OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  node /app/openclaw.mjs tui --session "$E2E_SESSION" \
  --message "Reply exactly: $NONCE"
```

The deployed container supplies config path, port and token. Use `tui`, inherited
configuration and container-local WebSocket authentication; remove the unneeded
model key from the client environment. Normal local device
pairing remains enabled. TUI session/native agent identifiers differ from OCC IDs.
`--message` submits the first prompt; keep the client open for subsequent input.
Ctrl+D exits only the client. Re-discover after a cutover before reattaching.
Revoke the operator OCC session and remove temporary cookie copies before the
interactive handoff; gateway authentication is independent.

The automated PTY check waits at most 240 seconds per reply, distinguishes an
assistant-rendered nonce-only response from an echoed prompt, sends a second
prompt in the same process, and exits only after both replies. A fresh client
state with an invalid token must fail; cached device tokens cannot satisfy denial.

## Implementation

1. Extend the production deployment guide with the exact Pod discovery and TUI
   command, normal pairing, continued conversation, cutover and explicit exit.
2. Add `tests/integration/production-tui-k3d-real.test.mjs` using existing Kubernetes
   fixture utilities. Its explicit dependency is the development change's shared
   `tests/helpers/tui-pty.py`: adopt its stabilized commit before verification.
   Use `conversation --first-nonce N --first-prompt P --second-nonce N2
   --second-prompt P2 --timeout 240 -- <kubectl exec command>` and its denial mode.
   Install the actual chart; do not replace its API, worker or bootstrap with
   host-composed components. The existing harness-topology suite composes services
   on the host; it does not install Helm. Keep fixtures confined to infrastructure.
3. Record proof per outcome with exact source, image, cluster and model identities.
   Default test cleanup removes only its owned resources; the explicit operator
   rehearsal retains the final setup and prints nonsecret attach coordinates.
4. Write and validate [the production TUI flow](../../docs/flows/production-tui.md),
   then independently verify, publish a ready PR, and check its required CI.

## Verification

Local production Helm proof passed with `gpt-5.1`: four assistant nonce replies
across two revisions, authentication denial, explicit exit, network isolation,
credential checks and session revocation. The final setup remains attachable.

| Outcome | Required evidence |
| --- | --- |
| Production installation | Helm initialization Job completes; API and worker ready on real PostgreSQL, authenticated Installation read succeeds. |
| Real provisioning | API-created Namespace ready; tenant RBAC scoped; Agent active revision and exact Ready gateway/config match. |
| Interactive TUI | Two fresh assistant nonce responses in one open client; recorded process remains running between replies. |
| Authentication and exit | Fresh-state invalid-token denial; valid TUI connects; Ctrl+D exits and gateway remains ready. |
| Cutover | Second admitted immutable revision becomes active and newly selected gateway serves another real TUI conversation. |
| Network isolation | Allowed client reaches actual gateway; unapproved namespace cannot; positive control confirms target listens. API isolation and private-egress denial are checked similarly. |
| Credential/RBAC boundaries | Worker cannot directly read Secrets/manage RoleBindings; key only in selected embedded gateway, absent from API/worker/config/revision and captured output. |
| Continued usability | Final rehearsal setup remains running with an exact attach command; unrelated clusters, stacks, databases and default kubeconfig stay unchanged. |

Missing image, tools, credential, provider access or enforcing NetworkPolicy is a
failed prerequisite, never a substituted fixture or skipped success. Local k3d
proves the production installation path, not deployment to a remote shared cluster.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:03]: Recorded completed implementation and the verified production Helm/TUI proof for PR #3 after integrating the merged development guide. (01a059fc-1a4d-7fa2-8375-3999ef6aeff8 - dd8aea5)

- [2026-08-31 16:22]: Verified the production Helm/TUI journey and selected explicit bootstrap-free demo configuration; implementation awaits PR review. (01a059fc-1a4d-7fa2-8375-3999ef6aeff8 - de8a4390e7dfe0576647c1355a9ea1f0e94d789f)

- [2026-08-31 15:47]: Added the approved production installation and interactive TUI completion requirement. (01a059fc-1a4d-7fa2-8375-3999ef6aeff8 - b43cc49c45fa6275e79985be0eabb517743c6a23)

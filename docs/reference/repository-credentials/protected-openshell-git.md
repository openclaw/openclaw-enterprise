# Protected repository access with OpenShell

Credential Design 1.0 retires the protected repository exchange described here.
The procedure below records the behavior of earlier releases. Use Source-backed
native Git with repository Read or Read/write grants. Branch protection,
request-time exchange checks and REST operations are outside 1.0.

The protected OpenShell sender verifies middleware denial before preparing
credentials and releasing the Agent. Repositories must share permissions. OCE
checks token scope against canonical repository IDs. GitHub governs refs and
API permissions. Select model authentication separately.

`Ready` and an accepted hook do not prove exact dispatch or v7 reduction.
`github-installation` requires a separate preview opt-in. For Source-backed
native Git, see [GitHub App setup](../../guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent).

## Prerequisites

- **Kernel.** The Driver requires Landlock (`hard_requirement`). Sandboxes need ABI
  v3 or later and Linux 6.2 or newer. Ubuntu 22.04's 5.15 kernel cannot start them.
- **Supervisor trust.** The supervisor uses its image's CA bundle for GitHub and
  model TLS. Include any private or intercepting CA in that image; otherwise model
  probes time out and Git requests fail.
- **Unattended commands.** With
  `plugins.entries.codex.config.appServer.approvalPolicy: on-request` and no
  approver, Codex declines the shell commands it asks about, so Git never runs. For
  unattended qualification, select an approval policy appropriate for that environment.

<a id="configuration-for-a-qualified-release"></a>
<a id="install-without-the-repository-broker"></a>
<a id="prepare-the-request-phase-service"></a>
<a id="register-the-request-phase-service"></a>

## Deprecated configuration

Do not configure new credentialed deployments on the legacy credential-egress
Driver. For an existing qualified release, retain its recorded sender, trust,
custody, and network settings until its work is settled. The
[earlier release-specific configuration](https://github.com/openclaw/openclaw-enterprise/blob/691409b2130052b4403d396dd91c7f20b468cd47/docs/reference/repository-credentials/protected-openshell-git.md#configuration-for-a-qualified-release)
records the former setup procedure. Use
[native TokenService Git](../../guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent)
for new access.

## Grant access to a GitHub App installation

An existing installation-wide admission records a distinct
`installationAccess.repositoryRef`, Namespace `accessMode: installation`, and
one Agent binding with `profile: github-installation`. It gives access to the
installation's repositories, subject to GitHub membership and permissions. No
default or wildcard selects this scope; the sender must confirm
`github_installation` support. The legacy OpenShell credential-egress Proxy requires
`observedHookPreviewWorkspace`; otherwise deploy answers
`409 RESOURCE_CONFLICT`. Missing or incompatible registration returns
`503 DEPENDENCY_UNAVAILABLE`. Use 0.1.6 for incident key distrust; 0.1.5 remains affected.

Repository grants require authenticated `allowlist`/`exact` with only `pre_credentials`.
Opted-in installation preview also accepts both binding fields absent; partial,
malformed or explicit optional/wrong values fail. Both paths retain policy,
recipient, isolation and authenticated launcher-denial checks. For `git-write`,
startup probes stay within the selected repository endpoint without broadening
grants, accessing credentials or releasing the Harness. `github-repository` and
`github-installation` providers retain their discovery-path probe.

Absence grants only observed assurance: 0.1.5 and 0.1.6 default dynamic registrations
emit identical absence, without a distinct advertised support signal. Before
qualification, intentional downgrade is indistinguishable. After qualification,
registration changes break the recipient fingerprint and close the route.
Repository grants never use this fallback.

OCE does not add a ref allowlist to installation scope. GitHub's membership,
permissions and branch rules set its limit. See
[historical operator verification and withdrawal](https://github.com/openclaw/openclaw-enterprise/blob/105ffee9962176cf42fc7cfe013b8b94831435db/docs/guides/credential-proxy.md#verify-use-loss-and-withdrawal)
for profile-specific allowed/denied requests and the required model-source choice.

## Use the admitted repository

Process-scoped `safe.directory` permits the Sandbox's root-owned mount without trusting
nested repositories or changing persistent Git configuration. `push.negotiate=true`
reduces transfers.

<a id="plan-for-request-limits"></a>

OpenShell 0.1.6 buffers requests. Selected-repository REST JSON and Git fetch
negotiation each allow 1 MiB. GraphQL, installation-preview API, and ref-scoped
draft JSON allow 64 KiB. Git push allows 4 MiB. Contents API writes count base64,
metadata and whitespace. Resource segments allow letters, digits, underscores,
hyphens and dots. Percent-escaped filenames are refused.

With `github-repository`, use selected HTTPS Git URLs; API operations use token
permissions. Both API scopes refuse runner-token and deploy-key creation.
Both allow read-only API-root discovery for `gh auth status` under current grants.
Selected-repository requests to `api.github.com` accept `Time-Zone: Etc/UTC`;
GraphQL POSTs also accept `Graphql-Features: merge_queue` and bounded
`X-GH-CACHE-TTL` hints (such as `24h0m0s`).
For `gh pr list --search`, OCE ignores hint values, checks current authorization
and refuses duplicate headers.

With `git-write`, use exactly
`https://github.com/$OCE_OPENSHELL_GIT_REPOSITORY.git` for clone, fetch and push.
Credential paths are case-sensitive: mixed-case URLs or those missing `.git`
receive no credential. Git reports `could not read Username` or
`The requested URL returned error: 403`.

Finite access ends at its deadline or when an admitted binding is removed.
Removal withdraws that revision's whole Git set; re-adding cannot restore it.
Remove standing approval with its current generation **before** clearing bindings.
An authorized request can finish after withdrawal.
Removal during incomplete activation can fail deployment while retaining the independently
verified runtime; workspace setup stays pending.
See [withdrawal and retained supervision](../../flows/agent-repository-credentials.md#6-maintain-recover-and-retire-ownership).

With `git-write`, draft POSTs to `api.github.com` accept one
`Time-Zone: Etc/UTC` header. `draftPullLimit: one-per-grant` allows one draft
across Agents and versions sharing the grant. For more drafts from that ref,
set `draftPullLimit: none` in the Namespace policy and deploy a new version.
OCE still records each draft use and checks draft status, head and base.

A one-draft grant spends its allowance at authorization, before
OCE knows whether GitHub created a draft. On an uncertain push or draft outcome,
inspect the original remote ref or PR and retained operation; do not replay it.
See [Credential Proxy uncertainty](../drivers/credential-proxy.md#cancellation-retries-and-uncertainty).

## Diagnose a refused request

GitHub App `permissions` flags alone prove neither write access nor denial.
[Verify the authorized operation and remote result using the matching legacy procedure](https://github.com/openclaw/openclaw-enterprise/blob/105ffee9962176cf42fc7cfe013b8b94831435db/docs/guides/credential-proxy.md#verify-use-loss-and-withdrawal);
Git push success does not prove pull-request API access.

Git hides JSON error bodies. A refused clone, fetch, `ls-remote` or initial push
reports HTTP 403 (exit 128). Refused push uploads, usually for another branch or
tag (`request_not_allowed`), report `error: RPC failed; HTTP 403` and
`fatal: the remote end hung up unexpectedly`. Even with `Everything up-to-date`
(exit 1), GitHub received nothing.

After a known pre-send refusal, trace a fresh read. Git redacts authorization:

```bash
GIT_TRACE_CURL=1 git ls-remote origin 2>&1 | sed -n 's/.*<= Recv data: //p' \
  | tr -d '\n' | grep -o '"reason_code":"[a-z_]*"'
```

The draft helper reports
`Draft not created: the repository route refused it (access_withdrawn); GitHub did not receive it.`

### Reason codes

| Code                          | Meaning                                                                                                                      | What to do                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `request_not_allowed`         | The selected profile does not admit the request; repository-scoped limits include ref, repository and draft constraints      | Do not retry. Change the request or ask an operator                                |
| `draft_already_opened`        | The grant's one-draft allowance was consumed; creation may be uncertain                                                      | Inspect GitHub without replay; see the [draft limit](#use-the-admitted-repository) |
| `access_withdrawn`            | This version's repository access ended: the binding was removed, the version was replaced or stopped, or its session expired | Do not retry. An operator binds and deploys                                        |
| `credential_unavailable`      | The route lost its credential, for example because GitHub rejected the App key or a renewal failed                           | An operator checks the worker log; a rejected key needs a new deploy               |
| `route_blocked`               | The worker closed this version's route for good, for example after the Sandbox was replaced                                  | An operator deploys a new version                                                  |
| `route_not_ready`             | The route is starting, verifying or briefly unavailable                                                                      | Retry in a minute                                                                  |
| `online_authorization_denied` | The worker did not answer in time, matched no route, or had too many decisions in flight for the Sandbox or in total         | Retry once, then ask an operator                                                   |

Retry only known pre-send refusals. Deploying versions return `route_not_ready`
until activation.

### Worker log

After held enrollment failure and cleanup, check worker logs.
`worker.openshell-git-probe-failed` records the HTTP 400 `reason`:

- `probe_process_failed`: curl failed; optional integer `code` is its exit status (1–99).
- `probe_response_invalid`: the launcher could not read response JSON.

The event omits stdout, stderr, response bodies, URLs and proofs. Collector
attributes: `occ.git_probe.reason` and optional `occ.git_probe.exit_code`
([limits](../../flows/common-logging.md#7-collector-exports-only-operational-classes)).
A parsed unexpected denial returns HTTP 409 `preview_not_observed`.

For refused Git requests, `worker.openshell-git-denied` records `reasonCode`
from the table, the detailed `reason` (such as `ref_not_allowed`, `draft_rejected`,
`session_closed`, `material_unavailable`, `installation_changed` or `route_blocked`),
Sandbox ID and supervisor request ID. For lost credentials,
`worker.openshell-git-route-warning` carries the same `reasonCode` to distinguish
a removed binding (`access_withdrawn`) from a rejected App key (`credential_unavailable`).

## Route state, restarts and recovery

`REPOSITORY_GIT_ROUTE_PENDING` means unverified Sandbox, supervisor or provider
generation, or unavailable material; `REPOSITORY_GIT_ROUTE_BLOCKED` closes Git
until redeployment. Continued chat requires independent model access and verified
Git-only removal. Identity changes, GitHub overlap or failed observation can require
retirement. The worker reuses one conditional detach request while Git remains attached.
A moved Sandbox version or unknown Gateway outcome retires the runtime. Empty profile
workspaces select the platform profile. Files-only profiles may omit endpoint and
credential lists; identity and overlap checks still apply.

Standing succession requires a fresh `WITHHELD / CREDENTIAL_EXPIRED` report matching
the predecessor and generation, then rechecks Sandbox readiness and main-process identity.
Observation age plus monotonic read time must stay under 15 seconds at nanosecond precision;
both timestamps must be within 30 seconds of local time. An elapsed budget leaves the route
pending; contradictory evidence cannot authorize issuance, preparation or a route fence.
New installations and post-detach model completion require ready credentials and independent model authorization.

OpenShell 0.1.6 policy reload during Git detach can interrupt model and workspace
connections. Inspect uncertain turn outcomes before retrying.

Failed observations deny access until readiness verifies (1–10 s retry backoff).
Within the same revision and Sandbox, the original worker permits runtime recovery
after verifying policy, Providers and a fresh launcher denial. Worker replacement,
uncertain credential writes or unacknowledged launcher releases require a new
revision; replacement does not automatically deploy one.

Stop or revision replacement withdraws the binding; starting requires new authority.
The observed-only preview forbids process recovery and worker adoption.
See [Provider write deadlines](../drivers/credential-proxy.md#cancellation-retries-and-uncertainty),
[Token Service lifecycle](../repository-credentials.md#token-service-lifecycle) and
[prepared Git recovery](../../flows/agent-repository-credentials.md#6-maintain-recover-and-retire-ownership)
for expiry, quarantine and retirement.

Use `worker.openshell-git-denied` for request denials and
`worker.openshell-git-route-warning` for unavailable observations, credentials,
closed routes and retained resources. `OPENSHELL_GIT_RECONCILIATION_REQUIRED`
reports terminal failures; deploy a new revision after correcting the cause.
`OPENSHELL_GIT_WITHDRAWAL_UNRECORDED` requires confirmation of durable withdrawal
and Git detach or runtime retirement.

OCE drops closed routes after confirmed absence (two reads if never observed).
Failed reads retain them. Gateway authorization refusal prevents preparation,
adoption and verification; absence checks retry with backoff.
`worker.openshell-git-route` reports restoration in the original worker with
`durationMs`. Correlate revision and request IDs across these events.

[Managed replacement](../drivers/kubernetes-openshell-compute.md#lifecycle-and-retained-files)
withdraws the old route and removes its middleware and Provider before creating
the successor's binding for its admitted scope. The Sandbox and tombstone remain.
See that reference for replacement limits.

### Execution identity

Both Workspace modes use OpenShell APIs without Pod access. Missing or inconsistent
Sandbox ownership, readiness, execution or Provider evidence denies Git. Reconnects
require fresh evidence; replacement needs admission. Expiry verifies the original execution.

OCE trusts authenticated OpenShell reports. It does not independently attest them
or detect a compromised supervisor claiming an earlier identity. See the
[verification flow](../../flows/openshell-managed-workload.md).

### Qualification history

OpenShell 0.1.4 (`5a7728c3`) authenticated the Sandbox principal but did not attest
reported execution identities. Provider changes reset Sandbox connections,
including workspace and model streams, with observed outages of 1–7 s.
Activation reported `REPOSITORY_GIT_MATERIAL_PENDING`,
`WORKSPACE_NODE_RECONNECT_PENDING`, and `WORKSPACE_NODE_PENDING`.
Qualify identity and connection continuity on the selected release; inspect
uncertain outcomes before retrying.

## GitHub App key rotated or revoked

See [replace a rejected App key](../../guides/repository-credentials/team-runbook.md#replace-a-rejected-app-key).
A ready Agent is not evidence of usable Git material. A changed key retires
issued material within about a minute, even when GitHub rejects the new key.

## Move from the earlier trial

Use [stop and settle](../../guides/deploy/production-upgrade-credentials.md)
before changing the old owner. New startup rejects the broker trial. Keep
[explicit native Git](prepared-native-git.md) separate from protected delivery.

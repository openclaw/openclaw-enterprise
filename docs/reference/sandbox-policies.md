# Per-Agent sandbox network policies

Each Agent owns one Namespace-scoped `SandboxPolicy`. It stores desired network
additions separately from the Installation's Sandbox Driver defaults. OpenShell
supports this contract with Kubernetes Compute and dedicated Agents. Other
Drivers opt in explicitly; the `networking` facet alone does not imply support.

Policy operations require an explicit `facet` in the HTTP path and controller
argument. The current implementation supports `networking`; `filesystem` and
`process` requests fail explicitly without reading or changing network additions.
The console discovers the owner’s contextual action URLs; the CLI exposes
`--facet networking`.

## Discovery and preview

The selected Sandbox implementation contributes the shared definition for
`(agent, sandbox-network-policy)`, whose value is `{ additions }`. Agent discovery
returns its schema and contextual read, validate, save, and apply URLs. Policy GET
includes the same `configuration` descriptor when supported. Discovery requires
exact-Agent read and filters out contributions whose owner read is denied.
Unavailable actions remain hints; every invocation rechecks current authority.

`POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/validate`
accepts `{ expectedVersion, additions }`. It uses the same `manage_policy` and
policy `update` checks, editing flag, version, pending-work checks, schema,
semantics, ceiling, and provider admission as save, without policy or job writes.
Invalid additions return HTTP 200 with `data.success: false` and `error.details`;
a malformed envelope returns HTTP 400. Authorization and concurrency refusals
keep their resource errors. Each detail has a JSON Pointer, code, and safe message.
Preview success neither saves nor grants authority to a later save or apply.
Ceiling refusals identify the Installation delegation limit and retain
`OUTSIDE_CEILING` details at the rejected addition. The CLI prints these field
details with the error; it does not reduce them to a generic Driver refusal.

## Authority and admission

Editing defaults to disabled. Enabling or disabling
`Agent.sandboxPolicyEditing` requires both Installation and exact-Agent
`administer`. Changing additions or requesting live application requires exact-Agent
`manage_policy` and exact-SandboxPolicy `update`. Live application also requires
SandboxPolicy `read`: it admits and returns the saved additions. When saved
additions exist, Agent deploy and an Agent update that leaves repository bindings
also require SandboxPolicy `read` before any refusal that names them. Reads require
`read` on both resources. Ordinary Agent `update` does not authorize these operations.
`TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing` is a temporary
controller/HTTP operation; callers must expect replacement when Guardrails owns
these restrictions.
Disabling editing preserves additions and admitted work.
Revocation requires an explicit policy change or Agent shutdown.
Without per-Agent network policy support, enabling editing returns HTTP 409;
disabling it stays allowed. When the Installation selects no Sandbox Driver,
validate, save and apply return the same 409 right after authorization. Policy GET
then returns `capability: null` and the cause in `unavailableReason`.

If the controller cannot read the active revision of an Agent with saved
repository grants, GET returns the saved policy with `protectedExecution`,
`capability` and `defaults` set to `null`. See `unavailableReason`. An
authorized editor can clear saved grants. Use a compatible controller and
Worker to inspect or stop the workload and confirm retirement.

The trusted startup field `sandboxNetworkPolicyCeiling` bounds additions in both
the API and worker. Each entry has `id`, an exact absolute `binary` path, a DNS
`host`, and `ports` containing inclusive `{from,to}` ranges. Defaults grant
access; the ceiling grants no access. An absent or empty ceiling delegates no
additions. A changed ceiling governs future admission and pending application;
it does not revoke already running access automatically.

```yaml
sandboxNetworkPolicyCeiling:
  - id: approved-service
    binary: /usr/bin/python3.11
    host: service.example.com
    ports:
      - from: 443
        to: 443
```

The complete requested scope must fit the ceiling. Executable paths must match
exactly; a symlink or alternate interpreter path is a different executable.
`*.example.com` covers one DNS label, not the apex or deeper subdomains. A
wildcard addition requires that exact wildcard in the ceiling. Port coverage may
combine adjacent ceiling ranges; gaps remain unauthorized. Drivers reject
unsupported constraints. Ceilings and Agent additions allow 16,384 grants,
with up to 16 ranges each; OpenShell additionally caps each grant at 1024 distinct ports.
Preview, update and apply accept 32 MiB including JSON escaping and whitespace,
subject to an explicit `maxBodyBytes` override. They share a replica-local,
per-principal budget of 2 requests/second, burst 10, across Agents; exhaustion
returns `429 SANDBOX_POLICY_RATE_LIMITED` with `Retry-After` before body reads.
They also share the [early authorization budget](api-explorer.md#write-request-limits)
with Preset and Configuration writes.

Helm stores complete trusted startup for API, worker and preflight in one Secret.
All decoded fields must fit the [1 MiB limit](https://kubernetes.io/docs/concepts/configuration/secret/#size-limit).
Measure compact UTF-8 bytes; variable grant sizes prevent a fixed entry count.
The 16,384-rule fixture's ceiling alone is 1,780,053 bytes and cannot fit.
File startup proves schema capacity, not full-size Helm deployability.

Default rules, workspace access, model credential delivery and Compute isolation
retain their owners. Users cannot submit provider YAML, alter defaults, share
policies or change ownership. Identities use `sbp_` and the Agent UUID. Agent
lifecycle creates and removes policies and their exact IAM records; no standalone
create/delete or policy-reference API exists.

## Desired and applied versions

Saving requires `expectedVersion`, advances the desired version and performs no
provider mutation. Deploy explicitly to freeze defaults and additions into a new
AgentRevision, with normal authorization and interruption behavior.
**Save and apply to current revision** sends reviewed additions, expected version
and running revision to the apply URL; save and enqueue are atomic. Empty additions
remove Agent grants; omission applies the saved version. After a lost response,
refresh policy and application status before proceeding.

Live application additionally requires a supporting Driver, enabled editing, the
expected desired version, and the exact running revision. OCC records a durable
application with its requester, operation ID, snapshot, and expected provider
resource version. The worker rechecks authority, ownership, lifecycle, and the
current ceiling before effects. It preserves defaults from the admitted revision.
A concurrent provider update causes a conflict instead of an overwrite.
OCC rejects a save that removes a pending application. After the worker records
`applied` or `failed`, a save that advances the policy to its next version can
clear the application record.

`pending` means enforcement is unconfirmed. `applied` requires the provider's
complete desired policy to match the admitted candidate and its active, loaded
version to match. `failed` includes an unconfirmed outcome: the provider may have
accepted a request before a connection or worker was lost. Exhausted stale work,
its failed application, and audit evidence commit in one transaction; interruption
rolls back all three so a later worker can retry recovery. Refresh, inspect, and
retry explicitly. Failure never triggers automatic redeployment.

For `failed` applications, the Console explains `reason`. The worker rechecks
each pass; failure after sending can leave rules enforced. It does not resend.

| `reason`                               | Cause and next step                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `SANDBOX_POLICY_REVISION_CHANGED`      | The Namespace or Agent changed state, or the revision changed. Refresh the Agent and policy.           |
| `AUTHORIZATION_DENIED`                 | The requester lost Agent `manage_policy` or SandboxPolicy `update`. Ask an Installation administrator. |
| `SANDBOX_POLICY_CEILING_CHANGED`       | The delegation ceiling no longer covers every rule. Remove those rules and save.                       |
| `SANDBOX_POLICY_UNSUPPORTED`           | The version's Sandbox Driver cannot apply or refused the rules. Deploy instead.                        |
| `SANDBOX_POLICY_PROTECTED_EXECUTION`   | The version runs under protected execution. Remove the saved rules.                                    |
| `SANDBOX_POLICY_VALIDATION_FAILED`     | The Driver settings refused the rules. Review, correct and save them.                                  |
| `SANDBOX_POLICY_PLACEMENT_UNAVAILABLE` | The Compute Driver changed since the version deployed. Deploy a new version.                           |
| `SANDBOX_POLICY_PROVIDER_FAILED`       | The provider reported failure or changed version. Refresh and apply again.                             |
| `SANDBOX_POLICY_UNCONFIRMED`           | No confirmation in time; the provider may have applied part. Refresh and retry.                        |

Policy GET reports stored `defaultsRevisionId` and `deployedPolicyVersion`;
check workload status separately. If the running replacement deployed the saved
version and no application targets it, skip retrying. An earlier failure can still
show **Application unconfirmed** instead of **Deployed**.

After `SANDBOX_POLICY_REVISION_CHANGED`, retry only for a ready Namespace,
an active, running Agent and a revision needing the rules. Deploy a stopped
Agent only to start it.

Changing additions preserves the last confirmed live version. Revision snapshots
and attributable audit records preserve original admission. The Console separates
read-only revision or Driver defaults from the ceiling and additions.

OpenShell changes network rules through `UpdateConfig`, using a fixed nonzero CAS
version and request ID. It retains static filesystem/process policy and generated
transport access. Its create-time Sandbox spec remains unchanged; status reads
confirm the later policy version independently. Other Sandbox Drivers may support
redeployment without live application.

The OCC gateway identity needs OpenShell `sandbox:read` and Workspace role `user`
for `GetSandbox` and `GetSandboxPolicyStatus`, and `config:write` and Workspace
role `admin` for `UpdateConfig`. Recommendations through `GetDraftPolicy` need
`config:read` and Workspace role `user`. OpenShell scope enforcement must be configured
on its OIDC gateway; these permissions are separate from OCE resource authority.

## Repository network policy

Set `repositoryNetworkPolicyCeiling` on the Installation to delegate at most
32 named repositories, each with `read` or `write` access. Use lowercase
`owner/name` without `.git`. The TokenService Git profile also accepts short
repository names. An absent or empty ceiling delegates no access. A policy read
returns the subset approved for the Namespace.

### Source-backed native Git

Select the GitHub App Client and per-repository access in the Agent's
`repositoryAccess`. OCC resolves a Git Source for the approved repositories
and derives the Git-only policy when it admits the Agent revision. Deployment
returns `409 RESOURCE_CONFLICT` if the Agent also has a separately saved
`repositoryNetworkPolicy`, including an empty list. Omitting the field in a
policy update retains the saved list. Use an Agent draft without that list.
[Native Git access levels](repository-credentials/access-levels.md#native-git-delivery)

Native Git requires a supported TokenService model Source and the paired OpenShell
Sandbox and Credential Proxy. Dedicated Codex requires inspected Gateway and Agent
images. Dedicated OpenClaw requires service mode and an inspected Gateway image
qualified in the worker role. An unset image pin disables that placement.
[Controller build arguments](../guides/deploy/production-installation-preparation.md#build-a-controller-for-native-git)
A dedicated Agent with only standalone TokenService model revisions can add
native Git after Stop. An Agent with earlier unscoped Git needs a new Agent ID.
Clear the Agent's repository selections to request withdrawal on its running
revision. [GitHub App setup](../guides/repository-credentials.md#set-github-app-access-for-an-openshell-agent)

### Separately saved repository grants

The Sandbox policy API retains a separate grant list for legacy or qualified
Driver paths that support it. A policy GET requires Agent and SandboxPolicy
`read`. Its `repositoryNetworkPolicySaveSupported` field indicates whether the
caller can submit a list for validation or withdraw an existing list. PUT
requires editing enabled, Agent `manage_policy`, SandboxPolicy `update`, and
the current `expectedVersion`.

A first list or nonempty replacement requires empty ordinary additions,
a readable Configuration and model credential, current Namespace authority,
and a qualified Compute and Sandbox pair. An empty list denies all repositories
and requires SandboxPolicy `read`. If Driver support is lost, send
`additions: []` and `repositoryNetworkPolicy: []` to withdraw the desired grants.
The list remains saved. Live apply refuses an explicit list. Stop and confirm
the running workload has retired to end its current access.

When a Channel needs a bound Secret, OCC checks the saved repository policy
and the caller's Secret access before handing the value to the Channel Driver.
It rechecks deployment admission before creating the revision.

## Denials and recommendations

The console's **Policy denials** tab uses the existing bounded, exact-revision
Sandbox log path and its `read_logs`/administration rules. Typed metadata is
optional. Recognized OpenShell records are parsed by the Driver; OCC validates,
redacts, and applies the normal output and retention limits. Unknown fields stay
unknown. The denial count describes retained records, not unique requests or
lifetime denials. The console retains up to 1,000 log records and initially shows
five denials per page, newest first. Search filters the loaded window. Follow
collects new records without moving inspected rows; **Show newest** displays them. Buffer gaps, withheld records, permission denial, and missing
metadata remain visible. An empty successful read says **No denials in this window.**

The **Network policy** card precedes the denial log and distinguishes saved
policy from confirmed live application. **Allow this** prefills one exact rule;
**Allow selected** stages eligible denials selected across pages. **Select page**
selects only the visible page. Repeated executable/host/port requests and requests
covered by existing rules do not create additional rules. The complete proposed
policy preserves existing rules and passes the normal preview, save, and apply
admission. Selecting denials grants no access until the user reviews and saves.
**Manage rules** searches and pages explicit rules, five at a time, with separate
controls to edit or remove a rule. Installation defaults stay read-only.
The **Policy editing** switch sits beside **Manage rules**. With editing off,
**View rules**, suggestions, and **View network limits** remain available for
inspection; mutation controls are hidden. The ceiling has a separate read-only
dialog. **Policy details** on the page shows versions and Installation defaults.
Suggestions initially show three entries, with an explicit action to show the rest.
Their executable basenames have expandable full paths. Bulk review shows selected
record and new-rule counts, repeated requests, and already-covered requests.
The rule dialog footer offers review for unsaved changes, application for saved
changes, and **Done** when no action remains. Save feedback distinguishes saved,
pending, confirmed, and unconfirmed outcomes. **Refresh status** only reads;
**Retry application** requires an explicit refresh of the failed application and
rechecks application authority. Neither action starts a deployment.

Provider suggestions use a separate authorized and audited read. OpenShell's
`GetDraftPolicy` returns aggregated chunks, including its lifecycle and observation
count. Chunks can be observation-generated or agent-authored; origin is not
inferred. Only representable executable/host/port suggestions are shown. A
suggestion is an untrusted candidate, and its observation count is not a denial
count. Reviewing it prefills the ordinary policy editor. OCE validates and applies
its canonical policy; it does not approve native drafts directly.

Recommendation reads return at most 32 suggestions, with a 4 MiB provider message
limit. They share the replica-local read limits of two requests per second per
principal/Agent, burst ten and sixteen concurrent reads. Follow polls logs every
three seconds and suggestions every five seconds. Draft versions are not used as
complete change signals. Editing works without logs or suggestions.

See the [operator workflow](../guides/topics/agent-sandbox-policy.md),
[Driver contract](drivers/sandbox.md), [API](api.md), and
[source flow](../flows/agent-sandbox-policy.md). See [runtime coverage](../testing/openshell-coverage.md#agent-network-policy)
and the [implementation plan](../../specs/plans/0045-python-sandbox-policy-denials.md)
for verification and qualification limits.

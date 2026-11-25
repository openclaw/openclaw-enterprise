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

User editing is disabled by default. Enabling or disabling
`Agent.sandboxPolicyEditing` requires both Installation and exact-Agent
`administer`. Changing additions or requesting live application requires exact-Agent
`manage_policy` and exact-SandboxPolicy `update`. Live application also requires
SandboxPolicy `read`: it admits and returns the saved additions. When saved
additions exist, Agent deploy and an Agent update that leaves repository bindings
also require SandboxPolicy `read` before any refusal that names them. Reads require
`read` on both resources. Ordinary Agent `update` does not authorize these operations.
The editing switch is temporary until the platform Guardrails primitive owns
these restrictions. Its controller and HTTP operation are named
`TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing`; callers must
expect this API to change when Guardrails replaces it.
Disabling editing preserves approved additions and previously admitted work.
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

## Installation ceiling

The [persisted Installation ceiling](settings/installation-network-policy-ceiling.md)
bounds future network additions and pending applications. Startup seeds absent
state once; Installation administrators manage saved rules through Settings or
the owner API. It grants no access and does not revoke running access.

## Desired and applied versions

Saving additions requires `expectedVersion` and advances the desired policy
version. It performs no provider mutation. Deploy explicitly to freeze selected
Driver defaults and approved additions into a new AgentRevision;
deployment retains its usual authorization and interruption behavior.
**Save and apply to current revision** sends the reviewed additions, expected
policy version and running revision in one request to the existing apply URL.
OCC saves the new version and queues its application in one transaction. An
empty additions list requests removal of the Agent-specific grants. Omitting
the additions field applies the previously saved version. If the response is
lost, refresh the policy and its application status before deciding what to do.

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

For a `failed` application, the Console explains the `reason`.
The worker checks on every pass. If a check fails after sending, the Sandbox
may enforce the rules. The worker does not resend them.

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

Policy GET reports the stored active revision (`defaultsRevisionId`) and deployed policy
version (`deployedPolicyVersion`). Check workload status separately.
If the running replacement deployed with the saved version and no application
targets it, skip the retry. An earlier failure can still show **Application
unconfirmed** instead of **Deployed**.

After `SANDBOX_POLICY_REVISION_CHANGED`, retry only with a ready Namespace,
an active, running Agent and a revision that needs the rules. Deploy a stopped
Agent only if you intend to start it.

Changing additions preserves the last confirmed live version. Revision snapshots and
attributable audit records preserve the original admission. The Console separates read-only revision
or Driver defaults from the ceiling and additions.

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

Set `repositoryNetworkPolicyCeiling` on the Installation to bound repository delegation. It accepts up to 32 unique repositories in lowercase `owner/name` form without `.git`, each with `read` or `write` access. Startup rejects invalid entries. An absent or empty ceiling delegates nothing. The policy GET returns the subset approved for this Namespace.

`GET /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/networking` requires Agent and SandboxPolicy read access. GET returns the saved policy and tells an editor whether they can submit a list for validation. An editor can withdraw an existing list. For a first save, the hint is available when the selected Git scope overlaps the delegated Namespace scope on a qualified Driver pair, or when the pair accepts an empty list. When the scopes overlap, GET uses the Compute Driver's placement check if it provides one. PUT validates the whole list because a Driver can require multiple grants together.

GET `repositoryApiMaxima` shows eligible native Git and API levels before Agent grants apply.

To keep Git Write and disable PR creation, send
`{"repository":"owner/name","access":"write","apiLimits":{"pull_requests":"read"}}`
in the policy PUT. Preserve the other grants, then deploy again. The initial
grant and ceiling exclude API limits. See [API limits](repository-credentials/access-levels.md#api-limits).

PUT with editing enabled requires Agent `manage_policy`, SandboxPolicy `update` and the current `expectedVersion`. Omit `repositoryNetworkPolicy` to retain its saved value. A first list or a nonempty replacement requires empty ordinary additions, readable Configuration and Harness credential source, current Namespace authority, and a Compute and Sandbox pair that accepts the selected repository bindings and grants. An explicit empty list requests denial of all repositories and requires SandboxPolicy `read` even on the first save. This check prevents a caller from learning whether a list already exists. A pair lacking support refuses the first list. To withdraw an existing list after Driver support is lost, send `additions: []` and `repositoryNetworkPolicy: []`.

A save updates desired policy. Deployment checks the current grants and selected Drivers, validates the frozen revision, and rechecks authority before credential operations. The Worker refuses stale or unsupported policy before dispatch. Live apply refuses an explicit list. To end current access, use a controller and Worker that support the active revision to stop the Agent and confirm its workload has stopped.

When a Channel needs a bound Secret, the controller checks the saved repository
policy and the caller's Secret access before handing the value to the Channel.
The handoff shares the lock used by permission changes. The controller checks
permissions committed before it acquires the lock. It releases the lock before
waiting for the provider and checks deployment admission again before saving the
revision.

Save a repository list before first deployment to opt in. A Dedicated Agent with
only standalone TokenService model revisions can opt in later. Save the list,
complete Stop, then deploy. The Worker rechecks revision history before preparation.

With earlier unscoped Git, scoped deployment returns 409 even after Stop. A
delayed Gateway write can outlive Stop. Create a draft for scoped access and
save its list before deploying. Keep the original Agent and its storage for
existing chats and files. Reusing a [conversation label](agent-http-chat.md#conversations-and-execution)
does not transfer history.

After refusing a scoped replacement before its first provider call, the Worker
can maintain the serving predecessor if the deployment has no earlier attempt.
If earlier work could have changed the Gateway, the Worker keeps that repair
blocked. Stop the Agent and confirm its workload has retired.

The Kubernetes and OpenShell pair can admit [native Git](repository-credentials/access-levels.md#native-git-delivery)
for a dedicated Codex Harness, an OpenAI credential source and the managed
Gateway. The controller build must pin the inspected Gateway and Agent images
by manifest digest using `OCC_INSPECTED_WORKSPACE_GATEWAY_DIGEST` and
`OCC_INSPECTED_WORKSPACE_AGENT_DIGEST`. Qualify both role images together, then use the
[runtime-first controller build](../guides/deploy/production-installation-preparation.md#build-a-controller-for-native-git). Leaving the arguments empty disables this
placement. A first empty list can be saved. Deploying it is refused before
launch. Stop the active revision to retire its access.

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

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
unsupported constraints. Policy documents allow at most 32 grants and 16 ranges
per grant. OpenShell additionally limits each grant to 1024 distinct ports.

Default rules, generated workspace access, model credential delivery, and Compute
isolation remain controlled by their existing owners. Users cannot submit
arbitrary provider policy YAML, alter defaults, share policies, or change their
Agent/Namespace association. Policy identities use `sbp_` and the owner's UUID.
Policies are created and removed with the Agent; there is no standalone
create/delete or policy-reference API. Exact policy AccessBindings and
Restrictions are removed with their policy.

## Downloads on a running protected Agent

Enable [Installation download settings](configuration.md#protected-downloads).
The Sandbox and Credential Proxy must confirm effective rules on the running
revision. Stock OpenShell 0.1.8 lacks this Driver pair.

Before production use, verify the Drivers publish the installation used for model
access and any configured Git route. In the same protected shell, test a fresh
download, withdraw access and verify a fresh connection is denied. Model and Git
access should survive both changes.

Under **Network policy**, enable policy editing. In **Protected downloads**,
choose **Add destination**, enter the hostname and choose **Allow download**.
HTTPS defaults to port 443. For shared archive hosts specify the exact object path.
HTTP on port 80 requires an operator-listed mirror. Keep package signature and
checksum verification enabled.

Search by hostname or archive path, or filter by access state. **Requested** shows
the saved setting and Agent approval. **Confirmed access** reflects this revision’s
last receipt. Installation administrators can approve an eligible HTTPS hostname
for one Agent without changing Installation configuration. Delegated editors can
enable or disable approved destinations.

Disabling an exact path removes its desired rule and keeps its Agent approval.
If the Sandbox confirms the removal and a whole-host rule remains for the same
scheme, hostname, and port, that rule still covers the path. The approved entry
shows **Covered by host** and the broader URL. To stop new connections, disable
the covering rule and wait for confirmation. Choose **Withdraw approval** under
**More actions** to remove the Agent approval and any access that depends on it.
Existing transfers can finish.

When confirmation is pending, unavailable, or failed, the outcome may still be
unknown. **Last confirmed** describes the most recent receipt for the revision.
After a conflict or lost response, refresh the policy. In **Receipt details**,
match the request and receipt to your change and revision before submitting
another edit. If a later request has replaced yours, the displayed receipt cannot
confirm your earlier change. Test new connections from the
running Agent to verify enforcement by the Sandbox and Credential Proxy.

After a revision replacement, the Agent keeps its saved destinations and
approvals. When the new revision passes verification and has no receipt,
the card shows **Off on this revision**. Choose **Enable** to enable the
entry, or **Remove from desired** to remove it from the Agent’s saved list.

API clients use the existing networking `apply` endpoint. For example, an
administrator who just read policy version 3 can submit the following body,
using the active revision ID returned by the service.

```json
{
  "expectedVersion": 3,
  "revisionId": "rev_11111111-1111-4111-8111-111111111111",
  "downloadChange": {
    "action": "approve-and-enable",
    "destination": { "scheme": "https", "host": "registry.npmjs.org", "port": 443 }
  }
}
```

HTTP 202 means the change was queued. Read the policy again to see whether
the current revision confirmed it.

### Protected download limits

The [Installation `protectedDownloads` block](configuration.md#protected-downloads)
sets which executable paths and destinations are eligible. `executablePaths`
accepts unique literal paths of up to 512 characters. The Driver pair must match
the path exactly. Use letters, digits, and `_+.@-` in executable path segments.
The five optional lists accept unique entries and can be omitted or empty.
Unknown fields fail startup.

| Field                   | What it allows or excludes                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `reservedHosts`         | Excludes these hostnames. Credential route hosts are also excluded.                                                            |
| `httpMirrors`           | Allows HTTP on port `80` for these hosts.                                                                                      |
| `sharedArchiveHosts`    | Restricts these hosts to the exact HTTPS objects in `sharedArchiveObjects`.                                                    |
| `sharedArchiveObjects`  | Lists objects as `{ scheme: https, host, port: 443, path }`. The host must appear in `sharedArchiveHosts`.                     |
| `delegatedDestinations` | Delegates eligible destinations to policy editors. Each entry has `scheme`, `host`, and `port`, with an optional exact `path`. |

`reservedHosts`, `httpMirrors`, and `sharedArchiveHosts` must be disjoint. All
hostnames must be exact lowercase public DNS names of up to 253 characters.
Use `https` with port `443`, or `http` with port `80` for a listed mirror. A
destination without `path` covers the entire host on that scheme and port.
An exact `path` starts with `/` and can contain up to 2,048 characters. Use
letters, digits, and `._~+:@-` in path segments. Omit escapes, query strings,
fragments, and empty, `.` or `..` segments. Shared archive hosts require a
listed exact path.
An Agent can save up to 32 approved destinations and 32 desired destinations.
Installation delegation permits edits within its scope. Access starts after
the editor enables a destination and the running revision confirms it.

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

A `failed` application carries a `reason` code. The console shows its meaning
and next step. The worker repeats its checks on every pass, including passes
after it sent the policy. A failure after a send can leave the Sandbox running
that policy, and the worker does not send it again:

| `reason`                               | Cause and next step                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `SANDBOX_POLICY_REVISION_CHANGED`      | The current version changed or the Agent stopped. Apply again.                                         |
| `AUTHORIZATION_DENIED`                 | The requester lost Agent `manage_policy` or SandboxPolicy `update`. Ask an Installation administrator. |
| `SANDBOX_POLICY_CEILING_CHANGED`       | The delegation ceiling no longer covers every rule. Remove those rules and save.                       |
| `SANDBOX_POLICY_UNSUPPORTED`           | The version's Sandbox Driver cannot apply or refused the rules. Deploy instead.                        |
| `SANDBOX_POLICY_PROTECTED_EXECUTION`   | The version runs under protected execution. Remove the saved rules.                                    |
| `SANDBOX_POLICY_VALIDATION_FAILED`     | The Driver settings refused the rules. Review, correct and save them.                                  |
| `SANDBOX_POLICY_PLACEMENT_UNAVAILABLE` | The Compute Driver changed since the version deployed. Deploy a new version.                           |
| `SANDBOX_POLICY_PROVIDER_FAILED`       | The provider reported failure. Refresh and apply again.                                                |
| `SANDBOX_POLICY_UNCONFIRMED`           | No confirmation in time; the provider may have applied part. Refresh and retry.                        |

The last
confirmed live version remains recorded separately when desired additions change.
Policy GET returns the running revision as `defaultsRevisionId` and the saved
policy version it was deployed with as `deployedPolicyVersion`. When that version
is the saved version and no application targets that revision, the Sandbox
enforces the saved rules without live application. The console shows **Deployed**.
Revision snapshots and attributable audit evidence preserve the original admission.
The console shows read-only defaults from the running revision, or the selected
Driver before deployment, separately from the delegation ceiling and additions.

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

## Denials and recommendations

The console's **Network policy** tab uses the existing bounded, exact-revision
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

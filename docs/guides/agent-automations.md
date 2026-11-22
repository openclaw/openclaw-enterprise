# Schedule an Agent automation

Use the OpenClaw Control Plane (OCC) API to schedule a turn with the deployed
Agent's qualified, preapproved static Model Context Protocol (MCP) operations. OCC derives the tool ceiling; you supply the prompt and
schedule. When qualification establishes no eligible operations, the turn is
model-only. Read the [qualification and trust limits](../reference/agent-automations.md#execution-qualification)
first. The approved-MCP pilot remains under qualification; historical model-only
results do not establish its readiness.

## Prepare

Use a running Agent with native access enabled and its revision-specific automation
route ready. An Agent-wide native route alone is insufficient. For tool-bearing execution, the
runtime owner must verify exact static MCP operations, their canonical aliases,
endpoint, Agent-shared credential identity, provider actions and standing approval.
The operation must already work unattended under that Agent's authority. A raw
include filter or a successful call with your personal account is insufficient.

The current pilot covers Installation-attested anonymous HTTPS endpoints for
embedded OpenClaw and dedicated Codex. Stdio, general credentialed MCP, managed
MCP and native apps are not qualified. Ask the
Installation administrator to verify the [exact endpoint attestation](../reference/drivers/kubernetes-compute.md#automation-mcp-endpoints).

A nonempty grant requires Code Mode and tool search to be off before admission.
MCP execution also requires immutable images and the restricted core-plugin
namespace, without channel entries, Agent plugin selections or local plugin paths.
Set `gateway.nodes.pluginTools.enabled` and `gateway.nodes.allowSkills` to `false`;
environment overrides, Secret bindings and repository credentials are ineligible.
These are operator configuration choices that affect ordinary chat; creating an
automation does not change those settings. An empty MCP include list can expose
all operations. Never use it to revoke access.

Use the [human sign-in procedure](../reference/authentication/service-api-keys.md#sign-in-as-a-human-administrator). Exact-Agent `operate` admits your own records;
`administer` admits all OCE-owned records for that Agent. Service keys are refused.

Set `OCC_URL`, `NAMESPACE_ID`, `AGENT_ID` and `COOKIE` from that session. Use the
configured public origin for `OCC_URL`; never place the cookie in a shared script.

```sh
AUTOMATIONS="$OCC_URL/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/automations"
curl --fail-with-body --cookie "$COOKIE" \
  -H "Origin: $OCC_URL" -H 'Content-Type: application/json' \
  --data '{"name":"Daily check-in","enabled":true,"schedule":{"kind":"cron","expr":"0 9 * * *","tz":"America/Los_Angeles"},"prompt":"Write a short three-line check-in using only the context already provided. Do not use tools."}' \
  "$AUTOMATIONS"
```

Creation requires exact-Agent `operate`; `administer` alone does not substitute.
A successful response is 201 with the public UUID, native configuration revision
and normalized schedule. The tool ceiling is server-owned; do not submit tool fields. The example requests
only a text check-in; a prompt is not an additional authorization boundary.
Set `enabled:false` to create paused. A paused job still reserves its admitted grant.

## Inspect, pause and remove

List `GET "$AUTOMATIONS?offset=0&limit=50"` or read
`GET "$AUTOMATIONS/$JOB_ID"`. Keep the returned revision for the next mutation.
Lists omit prompts; refresh the scan if `snapshotRevision` changes between pages.

Pause with PATCH:

```sh
jq -n --arg revision "$CONFIG_REVISION" \
  '{enabled:false,expectedConfigRevision:$revision}' | \
  curl --fail-with-body --request PATCH --cookie "$COOKIE" \
    -H "Origin: $OCC_URL" -H 'Content-Type: application/json' \
    --data-binary @- "$AUTOMATIONS/$JOB_ID"
```

Set `enabled:true` to resume a supported job. PATCH can change its name, prompt or
schedule; it cannot enlarge the saved grant. OCC reasserts the permitted tool cap
and requires current qualification of the captured grant for edits or re-enablement.
After policy withdrawal, a disable-only PATCH, DELETE and history remain available
under their normal authorization and native-shape checks. A stale revision or
unsupported native shape returns 409. Read the job again before editing; an
Agent administrator can delete an unsupported managed job.

DELETE `$AUTOMATIONS/$JOB_ID?expectedConfigRevision=$CONFIG_REVISION` with the
same session and Origin to stop future scheduling and remove the native job.
Encode the revision as a query value. Success returns 204. Deletion does not undo
external effects of a turn that already ran.

Read `GET "$AUTOMATIONS/$JOB_ID/runs?offset=0&limit=50"` for history, including
after explicit or successful one-shot deletion, while native history is retained.
A deleted job that never ran has no retained history and returns 404.
Your `operate` grant admits your jobs; `administer` admits all OCE-owned jobs for
that Agent.

## Change the Agent's policy or credentials

An Agent policy expansion does not grant more tools to existing automations.
Changing an endpoint, credential identity, action scope or standing approval can
block a successor while retained automations depend on that binding. Paused and
uncertain jobs still count. Do not force a workload restart or overwrite a shared
Secret to bypass the refusal.

To remove a captured operation or change its binding:

1. Delete the affected automation through OCC and confirm grant retirement.
2. Deploy the narrower Agent policy through its normal lifecycle.
3. Create a new automation if scheduling is still needed.

Inspect the deletion result and, with the required audit access, its audit outcome.
Do not treat pausing as retirement. Confirmed native deletion retires the grant while preserving history.
An authorized DELETE of a bound, already absent native job can retire it and
return 404; a generic 404 does not prove retirement. `UNKNOWN_OUTCOME` does not
release the grant. See the [retirement contract](../reference/agent-automations.md#policy-changes-and-retained-grants)
for the distinction between a retired grant and retained history.

Removing an endpoint attestation alone does not stop a running native scheduler.
Disable or delete affected jobs to stop future schedules. Use service-side denial
to stop further provider calls; a call already issued can complete.

## Handle an uncertain result

`503 UNKNOWN_OUTCOME` means the mutation might have committed. Do not retry it
automatically. Keep the response's `Location` path: it identifies the automation
even if a successful one-shot has already disappeared. Inspect that path or its
`/runs` history. A recovered create can be disabled because activation did not
commit. Inspect its current revision and history before deciding whether to
request activation. See the
[error and persistence contract](../reference/agent-automations.md#runtime-and-failure-boundaries).

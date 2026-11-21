# Schedule a model-only Agent automation

Use the OCC API for scheduled model text, with no callable tools. Automations do
not run shell/file actions, code, subagents, messaging, apps, MCP tools or GitHub
reports. Review the [qualification and trust limits](../reference/agent-automations.md#execution-qualification)
before using a runtime. Ordinary chat and native administrators remain trusted;
OCC does not prevent their independent native edits.

## Prepare

Use a running Agent with native access enabled. Sign in with a human session using
the [HTTP API guide](http-api.md). Exact-Agent `operate` admits your own records;
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
and normalized schedule. The empty tool cap is server-owned; do not submit tool
fields. Set `enabled:false` to create paused.

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

Set `enabled:true` to resume a supported model-only job. PATCH can change its
name, prompt or schedule; OCC reasserts the empty tool cap. A stale revision or
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

## Handle an uncertain result

`503 UNKNOWN_OUTCOME` means the mutation might have committed. Do not retry it
automatically. Keep the response's `Location` path: it identifies the automation
even if a successful one-shot has already disappeared. Inspect that path or its
`/runs` history. A recovered create can be disabled because activation did not
commit. Inspect its current revision and history before deciding whether to
request activation. See the
[error and persistence contract](../reference/agent-automations.md#runtime-and-failure-boundaries).

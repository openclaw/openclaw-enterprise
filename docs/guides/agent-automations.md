# Inspect and pause Agent automations

Creation and activation are unavailable until a native route satisfies the
[execution-authority requirement](../reference/agent-automations.md#execution-qualification).
Use the OCC HTTP API to inspect, pause or delete retained OCE-owned jobs. Native
edits and imports are outside this workflow.

## Prepare

Use a running Agent with native access enabled. Sign in with a human session using
the [HTTP API guide](http-api.md). Exact-Agent `operate` admits your own records;
`administer` admits all OCE-owned records for that Agent. Service keys are refused.

Set `OCC_URL`, `NAMESPACE_ID`, `AGENT_ID` and `COOKIE` from that session. Use the
configured public origin for `OCC_URL`; never place the cookie in a shared script.

```sh
AUTOMATIONS="$OCC_URL/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/automations"
curl --fail-with-body --cookie "$COOKIE" "$AUTOMATIONS?offset=0&limit=50"
```

POST returns `503 AUTOMATIONS_UNQUALIFIED` without reserving ownership or
sending native create. The gate does not cancel work from a retained enabled job.
Pause/delete it, or use the ordinary Agent stop operation if a turn is in flight.
Gateway-wide scheduling and other native Agent functions are unchanged.

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

Enabling is refused. An edit must leave the job disabled; include `enabled:false`
to pause and edit atomically. An already-paused job can change its name, schedule
or prompt. A stale revision returns 409; read the job again before editing.

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
commit. Inspect its current revision; enabling remains unavailable. See the
[error and persistence contract](../reference/agent-automations.md#runtime-and-failure-boundaries).

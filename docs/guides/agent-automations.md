# Schedule an Agent automation

Use the OCC HTTP API to create and manage scheduled Agent turns. OCE must be the
sole automation manager; native edits and imports are outside this workflow.
Review [runtime and verification limits](../reference/agent-automations.md#verification-status)
before selecting a runtime.

## Prepare

Deploy the Agent with native access enabled. Sign in with a human session using
the [HTTP API guide](http-api.md). Creation requires `operate` on the exact Agent;
`administer` alone is insufficient. Service keys cannot call these routes.

Set `OCC_URL`, `NAMESPACE_ID`, `AGENT_ID` and `COOKIE` from that session. Use the
configured public origin for `OCC_URL`; never place the cookie in a shared script.

```sh
AUTOMATIONS="$OCC_URL/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/automations"
curl --fail-with-body --cookie "$COOKIE" \
  -H "Origin: $OCC_URL" -H 'Content-Type: application/json' \
  --data '{"name":"Daily report","enabled":true,"schedule":{"kind":"cron","expr":"0 9 * * *","tz":"America/Los_Angeles"},"prompt":"Generate the daily report"}' \
  "$AUTOMATIONS"
```

Success returns 201 with the public `data.id`, `data.configRevision`, the normalized schedule
and the next run time. Native staggering can affect the exact execution time.
Scheduled turns use the Agent's service authority and approved tools.

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

Set `enabled` to `true` to resume. PATCH can also change the name, schedule or
prompt. A stale revision returns 409; read the job again before editing.

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
commit; inspect its current revision before explicitly enabling it. See the
[error and persistence contract](../reference/agent-automations.md#runtime-and-failure-boundaries).

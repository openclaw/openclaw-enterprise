# Agent automation request flow

OCC forwards each supported automation request to native cron on the selected
running Agent revision. The [API reference](../reference/agent-automations.md)
defines the public operations and permissions.

1. The [HTTP route](../../apps/controller/src/http/agent-automations.ts)
   authenticates the human session and calls `getOperableActiveAgentRevision`
   to authorize exact-Agent `operate` and select the running revision. Mutation
   requests also pass existing Origin and CSRF checks.
2. The route calls the selected [Compute Driver](../../packages/contracts/src/drivers/compute/index.ts)
   `getGatewayEndpoint(revision)`, loads the shared Gateway API key through the
   existing resolver, and opens a private operator connection. The Gateway
   machine identity has `operator.admin`. The human receives neither the key
   nor that identity. This follows the [workspace access flow](workspace-files.md#6-compute-resolves-a-route-and-occ-loads-the-current-key).
3. OCC sends the corresponding `cron.add`, `cron.list`, `cron.get`,
   `cron.update`, `cron.remove`, or `cron.runs` request. Native cron owns
   the job ID, schedule normalization, revision check, execution, and history.
4. OCC maps the native result to the public response and records successful
   mutation audit evidence. It returns `UNKNOWN_OUTCOME` for an uncertain sent
   mutation and does not replay it.

OCC does not persist a parallel job, creator binding, or tool qualification
record. Operators can manage all native jobs for the Agent and create persistent
trusted runs with native tools. A job continues under native cron authority after
request completion; its authority is not limited to the caller's authority.

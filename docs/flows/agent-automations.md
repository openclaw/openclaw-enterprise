# Agent automation request flow

OCC forwards each supported automation request to native cron on the selected
running Agent revision. The [API reference](../reference/agent-automations.md)
defines the public operations and permissions.

1. The [HTTP route](../../apps/controller/src/http/agent-automations.ts)
   authenticates the human session and authorizes exact-Agent `administer`.
   Mutation requests also pass the existing Origin and CSRF checks.
2. OCC resolves the selected running revision and asks the existing
   [Compute Driver](../../packages/contracts/src/drivers/compute/index.ts)
   for its native browser request in admin mode. The Driver supplies the private
   transport request; the caller does not select a native endpoint or scope.
3. OCC sends the corresponding `cron.add`, `cron.list`, `cron.get`,
   `cron.update`, `cron.remove`, or `cron.runs` request. Native cron owns
   the job ID, schedule normalization, revision check, execution, and history.
4. OCC maps the native result to the public response and records successful
   mutation audit evidence. It returns `UNKNOWN_OUTCOME` for an uncertain sent
   mutation and does not replay it.

OCC does not persist a parallel job, creator binding, or tool qualification
record. A job continues to use native cron behavior after request completion.

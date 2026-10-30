# Recover a partial production upgrade

Preserve original [upgrade](production-upgrade.md) evidence privately, including Secrets.

A pre-window `--preflight-only` rehearsal leaves writers serving without
a production freeze. Do not use `--resume`. Settle cleanup using original evidence. Later deployment uses fresh evidence and
repeats checks.

For unfinished real deployments, keep the applicable freeze and single operator.
Before `prepared`, the helper has not stopped serving writers or changed the Helm
release. Reconcile, then restart with fresh evidence. After `prepared`, reconcile the original
process, live release, migration, rollout and dispatch. When eligible, resume with
original evidence, arguments, protected paths, kubeconfig contents, OCC URL,
scripts, flow and chart, adding `--resume`. Keep candidate flags and files semantically unchanged. The helper rechecks image pair and eligible nodes,
reads live Secret and Helm state, and accepts only recorded baseline or candidate
before continuing the frozen fleet.

For verified completed upgrades, clean up only. Do not rerun Helm, Agent rollout,
Doctor or `--resume`, or reinstate the freeze. `prepared` survives success.

## Clean up preflight resources

The release owner coordinates one upgrade operator for all cleanup. Do not
initiate a production freeze solely for cleanup.

Preflight cleanup is best effort. Leftovers can outlast startup, preparation or
upgrade success despite earlier warnings. On interruption, preserve evidence and
`.upgrade-lock` (retained on `SIGHUP`, `SIGINT`, `SIGTERM`). Before manual cleanup,
lock removal or retry, confirm the original helper and local children stopped;
reconcile accepted external operations and temporary resources. Only then remove
the original empty `.upgrade-lock`. It protects only this evidence directory.

Each successfully acknowledged and recorded create retains
`preflight-<slot>-identity.json`, with slots `networkpolicy`, `secret`, `api`,
`worker` and fields `kind`, `name`, `uid`. Optional NetworkPolicy and failed or
interrupted creates mean fewer than four files may exist. Match kubeconfig contents'
digest to original `parameters.json`'s `kubeconfigSha256`, and kubeconfig path,
context, namespace and release to its first four `arguments`, respectively.
Confirm the owner. Preserve the original intact confirmed record: it identifies
that create's UID, not current identity, name ownership or deletion authority.

Labels `app.kubernetes.io/instance=<release>` and
`app.kubernetes.io/component=upgrade-preflight` only discover candidates.
Stop and consult the owner for old helpers without records or missing, changed,
replaced, conflicting or uncertain evidence. Also stop for refused creates, lost
acknowledgement, successful creates without usable UIDs, or explicitly failed or uncertain
identity writes even if a file exists. None permits deletion or replay. Leave replacements alone; reconcile unknown
outcomes without repeating requests.
If the original is gone, no deletion remains.

Authorized manual deletion requires Kubernetes API enforcement of
`DeleteOptions.preconditions.uid`: delete the original kind, namespace and name
only if its UID matches the original record. Reading then deleting by name
cannot prevent replacement.

## Resume an unfinished prepared upgrade

For a failed writer scale, Helm upgrade, or rollout wait, read
`native-command-failures.tsv` in the evidence directory. Each tab-separated row
records the operation, component (`api`, `worker`, or `release`), and native exit
code. Rows remain after resume; they record client failures, not whether a
request took effect. Reconcile live state as described below before resuming.
Other failures and killed processes might not produce a row.

A Helm failure or disconnected response does not prove that the migration
rolled back. Read the current Helm status and history, inspect the initialization
Job and its Pods and logs, and inspect the retained database. The saved
`current-helm-status.json` is the last read and can predate the failed request.
A `pending-*` Helm release must be resolved separately before the helper can
continue. Do not start the old API or worker against a migrated database. If the
candidate Helm revision is deployed, the helper reads it back and continues
without rerunning Helm. Otherwise, wait
until the initialization Job and its Pods are terminal, then run the **candidate controller
image** with `node scripts/migrate-production.mjs --check` against the same
retained database, using its dedicated migrator credential and required database
CA in an authorized environment. On Kubernetes, the
[maintenance Pod](auth-maintenance.md#run-the-command) provides all three: set
`CONTROLLER_IMAGE` to the candidate image and replace its `args` with
`["scripts/migrate-production.mjs","--check"]`. Keep its exit-zero
`migration.checked` output in private evidence. Follow [migration history](../../reference/settings/operations.md#migration-history)
to interpret unsupported or uncertain state. Only after this check and review of
the Job outcome, repeat the command with `--resume --migration-history-checked`.
That flag records your attestation; it does not run the database check. The
helper keeps or returns OCC to zero replicas before retrying the candidate Helm
release. Prefer a reviewed forward fix; neither Helm rollback nor the helper
reverses committed migrations.

For an unknown Agent dispatch, the helper saves an Agent readback and stops
without replaying it. Inspect the exact Agent's authorized version history,
deployment status, and audit records, and allow any in-flight request to finish.
An unchanged selected version alone does not prove rejection, and a filtered
version list does not prove absence. If you can identify the accepted version,
record a private `dispatch/<same-prefix-as-intent>.json` containing its `id`;
the helper checks that exact deployment's status on resume. If evidence proves
the request was not accepted, deploy that Agent once with the ordinary OCC CLI
and save its successful JSON response under that name. Preserve the `.intent`,
error, and readback evidence. If the result is still uncertain, stop and
investigate rather than submitting another request. For a known failed version,
inspect its failure and explicitly deploy an authorized replacement before
recording that replacement's response; preserve the original response separately.
Each deployment snapshots current drafts.

For an accepted version, set `OCC_NAMESPACE` and `OCC_AGENT` to the exact
Agent IDs, `DISPATCH_PREFIX` to the matching evidence path without `.intent` or
`.json`, and `REVISION_ID` to the independently confirmed version. Verify the exact Agent and deployment before recording it:

```bash
if test -z "$REVISION_ID"; then
  printf '%s\n' 'Set REVISION_ID to the confirmed revision; do not resume.' >&2
elif test -e "$DISPATCH_PREFIX.json"; then
  if jq -e --arg id "$REVISION_ID" '.id == $id' "$DISPATCH_PREFIX.json" > /dev/null; then
    printf '%s\n' "Deployment $REVISION_ID is already recorded in $DISPATCH_PREFIX.json."
  else
    printf '%s\n' "$DISPATCH_PREFIX.json does not record $REVISION_ID; inspect it and do not resume." >&2
  fi
elif occ --output json --namespace "$OCC_NAMESPACE" agent deployment-status "$OCC_AGENT" "$REVISION_ID" > "$DISPATCH_PREFIX.confirmed-status.json" &&
  jq -e --arg namespace "$OCC_NAMESPACE" --arg agent "$OCC_AGENT" --arg revision "$REVISION_ID" \
    '.namespaceId == $namespace and .agentId == $agent and .deploymentId == $revision' "$DISPATCH_PREFIX.confirmed-status.json" &&
  jq -n --arg id "$REVISION_ID" '{id: $id}' > "$DISPATCH_PREFIX.json.tmp"; then
  mv "$DISPATCH_PREFIX.json.tmp" "$DISPATCH_PREFIX.json"
else
  printf '%s\n' 'Deployment could not be confirmed; do not resume.' >&2
fi
```

Keep the shell's `umask 077`. If the status read is denied or does not identify
the confirmed deployment, do not create the response file. The block never
overwrites an existing response file: a rerun reports it when it records the
same ID, and otherwise says to inspect it. The helper
rechecks its status on resume; it does not verify how you identified an
accepted request.

If the candidate API and worker refuse to start because of
[split-layout Gateway storage](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations),
`--resume` cannot succeed. Keep both namespaces and their storage, and return to
the previous controller image after the check below.

Before selecting an older controller or runtime image, verify it can read all
state written by the candidate and restore compatible data if required. Never
delete Agents, versions, PVCs, or the bootstrap volume to force recovery.

For stalled ReplicaSet creation, check [namespace object capacity](upgrade-checklist.md#check-replicaset-capacity).

## Correct a refused Agent deployment

The startup preflight refuses some such drafts before any writer stops. When
OCC still refuses an Agent's deployment with a 4xx answer, such as
`HTTP 400 ... must use reviewed task actions` for a saved Configuration that
the new release refuses, it saved no new version. The command lists each
refused Agent with OCC's message, keeps the message in `dispatch/*.rejected`,
and stops. Correct the cause, for example with `occ configuration update`, and
repeat the command with `--resume`. The resume deploys each refused Agent once,
so do not deploy it yourself. A 408 or 5xx answer stays an unknown dispatch.
When OCC rejects the command's own service key, the command says so and lists
the Agents it did not deploy; get a new key, point `OCC_SERVICE_KEY_FILE` at it,
and resume.

## Correct a Doctor failure

Doctor shares the gateway container's memory limit. At the default heap cap,
the command waits for two consecutive readings with at least 640 MiB free or
one with at least 1024 MiB free. Initially unavailable cgroup data produces a
warning and Doctor runs. Once insufficient memory is observed, missing or failed
reads cannot admit Doctor and reset consecutive evidence. Fresh sufficient
readings must arrive within that Doctor's `--timeout-seconds`. Wait for memory use
to settle, then resume; consider a larger gateway memory limit if it stays low.
These readings do not reserve memory or guarantee that the gateway avoids an OOM kill.

A Doctor failure reports its command exit separately from gateway restart
history. It also names each gateway or agent Pod evicted, deleted, replaced, restarted, or
not `Ready` since then: an eviction kills Doctor (exit 137) without a restart.
A higher restart count on the same Pod with last termination
`OOMKilled` means an OOM restart occurred after the Ready baseline; it does not
prove Doctor caused it. The restart history is unknown when the gateway Pod was
replaced, its container status is missing, or its restart count went down.
Wait until the gateway is `Ready` again, then resume; the resume runs Doctor
again without new deployments.

`did not stay on the same Ready Pod without restarts through OpenClaw Doctor`
means that every Doctor passed, but afterward a named Agent's gateway Pod, or a
dedicated Agent's `agent` Pod, was evicted, deleted, replaced, restarted, or not
`Ready`. Doctors run one at a time, but node memory pressure from other Pods can
still evict them. Inspect the node's events, wait until that Agent's Pods are
`Ready`, then resume. The resume runs Doctor in the current gateway without new
deployments.

`OpenClaw Doctor ran out of its 384 MiB heap` means Doctor reached its heap cap;
check the separate gateway restart observation. Repeat the command with
`--resume` and `--doctor-heap-mib 768`, doubling again if needed. Each extra MiB
of heap needs the same free gateway memory before Doctor starts, so raise the
gateway memory limit first if the command then waits for memory. The command
refuses a cap too large for its 64-bit memory arithmetic before it changes anything.

## Correct an invalid Installation name

The stored Installation name must follow the API Name rule: 1 to 200
characters, with no leading or trailing whitespace, control characters, or line
or paragraph separators. The upgrade command's startup preflight reads the name
through OCC and checks it with the selected controller image's rule before any
writer stops. A failure prints the rule and `INSTALLATION_NAME_INVALID`, attempts
best-effort deletion of preflight resources, and stops; the old release keeps
serving. Follow [safe cleanup](#clean-up-preflight-resources) before retrying. To check
before the maintenance window, run this from the candidate checkout:

```bash
occ --output json installation get | node --input-type=module -e '
import { isName, NAME_RULE } from "./packages/contracts/src/index.ts";
let s = ""; for await (const c of process.stdin) s += c;
if (!isName(JSON.parse(s).name)) { console.error(NAME_RULE); process.exit(1); }'
```

No API renames an Installation, so correct `occ.installation.name` with the
dedicated migrator credential (`OCC_MIGRATION_DATABASE_URL` as in
[the upgrade baseline](upgrade-baseline.md)). Shell-quote the name; psql's
`:'name'` quotes it for SQL:

```bash
psql "$OCC_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -v name='<intended name>' <<'SQL'
UPDATE occ.installation SET name = :'name';
SQL
```

psql prints `UPDATE 1`. The running API keeps the name it read at startup, so
restart it before you check again:

```bash
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system rollout restart deployment/openclaw-enterprise-api
kubectl --kubeconfig /secure/occ/kubeconfig --context '<reviewed-context>' \
  --namespace openclaw-system rollout status deployment/openclaw-enterprise-api
```

The database accepts some names the rule refuses, so run the upgrade command
again with a new evidence directory; its preflight checks the name again. If
the candidate API and worker log
`INSTALLATION_NAME_INVALID` after the helper stopped OCC (the name changed after
the preflight), Helm's `--wait` has marked the candidate release `failed`:
rename as above, follow the Helm failure steps above, then repeat the command
with `--resume --migration-history-checked`.

## Correct values the candidate refuses

Before the window, render the candidate chart with live values from its checkout:

```bash
helm template oce deploy/helm/openclaw-enterprise -f /secure/occ/values.yaml > /dev/null
```

The helper renders and runs its
[startup preflight](production-upgrade.md#upgrade-the-control-plane), refusing these
values while old writers serve. `helm template` cannot check every runtime value
in the mounted Installation; Compose has no chart. On a stock-chart upgrade, the
initialization Job runs `installation-check`, then the `migration` init container,
then `bootstrap`, before API and worker rollout. The check can refuse before migration
starts; later failures can follow a committed migration. Inspect the initialization
Job and its Pod's container statuses and logs, and the retained database's migration
history, before choosing recovery. Keep old controllers off a database that may have migrated.

The helper refuses these corrections in candidate files. Apply live values or Installation
YAML with the installed release's checkout per
[Apply other Installation changes](production-upgrade.md#apply-other-installation-changes),
keeping baseline files matched to live state.

| Refused value                                                                                                                                                                     | Correction                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.github.allowedOrgs`, `allowedTeams` or `auth.google.allowedDomains` set while that provider is disabled                                                                     | Remove the list.                                                                                                                                                                                                |
| `""` or `{}` for those allowlists, or `{}` for a provider's `egressCidrs`                                                                                                         | Write `[]` or remove the key.                                                                                                                                                                                   |
| An IPv4-mapped `api.trustedProxy.cidrs` entry with a prefix from 97 to 128, such as `::ffff:a00:0/104`                                                                            | Write the IPv4 CIDR with the prefix minus 96: `10.0.0.0/8`. A Compose install's API refuses the same entry in `OCC_AUTH_TRUSTED_PROXY_CIDRS` at startup.                                                        |
| An IPv6 `api.trustedProxy.cidrs` entry that contains `::ffff:0:0/96`, such as `::ffff:0:0/96`, `::ffff:a00:0/64` or `::/64`                                                       | Such an entry trusts forwarded headers from every IPv4 peer. List your proxies' own CIDRs instead.                                                                                                              |
| A Unicode `auth.baseUrl` host, such as `https://bücher.example.com`, with a punycode `agentNativeAdmin.sharedCookieDomain`                                                        | Write the host in punycode: `https://xn--bcher-kva.example.com`.                                                                                                                                                |
| An `auth.baseUrl` with a `/.` or `/%2e` path, a short loopback such as `http://127.1`, or U+200B (zero-width space)                                                               | Remove the path and invisible characters; write `127.0.0.1`.                                                                                                                                                    |
| An `auth.baseUrl` with a path or query, such as `https://example.com/occ`                                                                                                         | Serve OCC at the root of its own origin and set that origin, such as `https://occ.example.com`. Point browsers, CLI and API clients, and your proxy at the new origin.                                          |
| A `presets.files` Preset `name` with leading or trailing Unicode spaces (such as U+00A0), U+2028, U+2029 or C1 control characters                                                 | Correct the `name` in the file, or remove the entry. Startup adds a Preset with the corrected name; delete any saved copy with the old name you no longer need.                                                 |
| A Backend `id` with a C1 control character (U+0080 to U+009F)                                                                                                                     | Rename the Backend. No Agent can store such an ID, but ServiceAccounts created through that Backend keep it in a binding that cannot change: delete them before the rename and recreate them after the upgrade. |
| With `requireImmutableDigest: true`, an upper-case `gateway` or `agent` digest in the Installation's `drivers.compute.configuration.images`, such as `@sha256:ABC…` or `@SHA256:` | Write `sha256` and the hex digits in lower case; the digest is the same.                                                                                                                                        |

## Roll back across human sign-in

Migration `0037` adds the human sign-in state. `helm rollback` skips the
pre-upgrade migration Job, so it never reverses that migration.

Before GitHub sign-in is activated, scale `deployment/openclaw-enterprise-api` to
zero and wait for its Pods to disappear, run `helm rollback`, then verify password
sign-in before reopening ingress.

After activation, do not roll back; fix forward. The database refuses sessions
that the previous controller issues without a human sign-in binding, so it
cannot sign anyone in, and existing sessions expire within 8 hours. Never run
the previous and current controllers together.
To roll back anyway, first return to password-only sign-in with
[stopped maintenance](auth-maintenance.md#deactivate-external-sign-in).

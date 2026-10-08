# Recover a partial production upgrade

Use this page when [Upgrade production images](production-upgrade.md) stops before the release is verified. It assumes the evidence directory, arguments and maintenance restrictions from that run.

Keep the evidence directory and maintenance restrictions.
Do not start another upgrade to recover: its frozen Agent
inventory and dispatch records are needed to avoid duplicate deployments. If
preparation did not finish, the helper stopped before mutation; use a new
evidence directory after resolving the failure. Otherwise, repeat the original
command with the same arguments, protected file paths, kubeconfig contents,
OCC URL, scripts, flow, and chart, adding `--resume`. The helper rechecks the
recorded image pair and eligible nodes. Include the original candidate
flags and keep their files semantically unchanged. The helper uses the recorded
candidate, reads the live Secret and Helm release, accepts only the recorded
baseline or candidate, and continues the recorded fleet. It rejects unrelated drift. The evidence includes
Secret contents and must remain private.

If a killed process leaves `.upgrade-lock`, first establish that no helper or
its child commands are still running, then remove that empty directory and
resume. This lock covers only processes sharing this evidence directory; it
cannot stop other operators or automation.

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
without replaying it. Inspect the exact Agent's authorized revision history,
deployment status, and audit records, and allow any in-flight request to finish.
An unchanged active revision alone does not prove rejection, and a filtered
revision list does not prove absence. If you can identify the accepted revision,
record a private `dispatch/<same-prefix-as-intent>.json` containing its `id`;
the helper checks that exact deployment's status on resume. If evidence proves
the request was not accepted, deploy that Agent once with the ordinary OCC CLI
and save its successful JSON response under that name. Preserve the `.intent`,
error, and readback evidence. If the result is still uncertain, stop and
investigate rather than submitting another request. For a known failed revision,
inspect its failure and explicitly deploy an authorized replacement before
recording that replacement's response; preserve the original response separately.
Each deployment snapshots current drafts.

For an accepted revision, set `OCC_NAMESPACE` and `OCC_AGENT` to the exact
Agent IDs, `DISPATCH_PREFIX` to the matching evidence path without `.intent` or
`.json`, and `REVISION_ID` to the independently confirmed revision. Verify the exact Agent and deployment before recording it:

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
delete Agents, revisions, PVCs, or the bootstrap volume to force recovery.

## Correct an invalid Installation name

The stored Installation name must follow the API Name rule: 1 to 200
characters, with no leading or trailing whitespace, control characters, or line
or paragraph separators. The upgrade command's startup preflight reads the name
through OCC and checks it with the selected controller image's rule before any
writer stops. A failure prints the rule and `INSTALLATION_NAME_INVALID`, deletes
the preflight resources, and stops; the old release keeps serving. To check
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

## Correct values newer releases refuse

Releases after 2026-10-05 refuse some values that earlier releases accepted.
Before the maintenance window, render the candidate chart with your live values
from the candidate checkout:

```bash
helm template oce deploy/helm/openclaw-enterprise -f /secure/occ/values.yaml > /dev/null
```

The upgrade command also renders the chart and runs its
[startup preflight](production-upgrade.md#upgrade-the-control-plane) before it
stops OCC, so it stops on every row below while the old release keeps serving.
`helm template` cannot check the last three rows, which the API and worker read
from the Installation, and a Compose install has no chart. A plain
`helm upgrade` runs the migration Job before the API and worker fail on those
rows, and the old release must not then start against the migrated database,
so correct them first.

The upgrade command does not accept these changes in candidate files. Edit the
live values or Installation YAML and apply it with the installed release's
checkout, as in
[Apply other Installation changes](production-upgrade.md#apply-other-installation-changes),
so the baseline files match live state. Except where a row says otherwise, each
correction keeps the behavior the old release already had.

| Refused value                                                                                                                                                                     | Correction                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.github.allowedOrgs`, `allowedTeams` or `auth.google.allowedDomains` set while that provider is disabled                                                                     | Remove the list; the old chart ignored it.                                                                                                                                                                      |
| `""` or `{}` for those allowlists, or `{}` for a provider's `egressCidrs`                                                                                                         | Write `[]` or remove the key.                                                                                                                                                                                   |
| An IPv4-mapped `api.trustedProxy.cidrs` entry with a prefix from 97 to 128, such as `::ffff:a00:0/104`                                                                            | Write the IPv4 CIDR with the prefix minus 96: `10.0.0.0/8`. A Compose install's API refuses the same entry in `OCC_AUTH_TRUSTED_PROXY_CIDRS` at startup.                                                        |
| An IPv6 `api.trustedProxy.cidrs` entry that contains `::ffff:0:0/96`, such as `::ffff:0:0/96`, `::ffff:a00:0/64` or `::/64`                                                       | Such an entry trusted forwarded headers from every IPv4 peer. List your proxies' own CIDRs instead; this changes behavior.                                                                                      |
| A Unicode `auth.baseUrl` host, such as `https://bücher.example.com`, with a punycode `agentNativeAdmin.sharedCookieDomain`                                                        | Write the host in punycode: `https://xn--bcher-kva.example.com`.                                                                                                                                                |
| An `auth.baseUrl` with a `/.` or `/%2e` path, a short loopback such as `http://127.1`, or U+200B (zero-width space)                                                               | Remove the path and invisible characters; write `127.0.0.1`.                                                                                                                                                    |
| An `auth.baseUrl` with a path or query, such as `https://example.com/occ`                                                                                                         | Serve OCC at the root of its own origin and set that origin, such as `https://occ.example.com`. This changes behavior: point browsers, CLI and API clients, and your proxy at the new origin.                   |
| A `presets.files` Preset `name` with leading or trailing Unicode spaces (such as U+00A0), U+2028, U+2029 or C1 control characters                                                 | Correct the `name` in the file, or remove the entry. Startup adds a Preset with the corrected name; delete any saved copy with the old name you no longer need.                                                 |
| A Backend `id` with a C1 control character (U+0080 to U+009F)                                                                                                                     | Rename the Backend. No Agent can store such an ID, but ServiceAccounts created through that Backend keep it in a binding that cannot change: delete them before the rename and recreate them after the upgrade. |
| With `requireImmutableDigest: true`, an upper-case `gateway` or `agent` digest in the Installation's `drivers.compute.configuration.images`, such as `@sha256:ABC…` or `@SHA256:` | Write `sha256` and the hex digits in lower case; the digest is the same. Kubernetes could not pull the upper-case spelling.                                                                                     |

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

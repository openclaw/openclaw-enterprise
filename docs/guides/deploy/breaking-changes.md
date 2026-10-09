# Breaking-change notices

OpenClaw Enterprise (OCE) is pre-alpha and has no stable release, so a newer
main can refuse or break an Installation that an older build created. Each
change like that gets an entry here: what breaks, who is affected, how to tell,
and the steps. Before an upgrade, read every entry dated after the source commit
you run now, then follow the [upgrade checklist](upgrade-checklist.md) and
[production image upgrades](production-upgrade.md).

Entries are newest first. Steps marked _untested_ have not been run against a
real Installation.

## 2026-10-09: Dedicated Codex deployment requires the main Agent

**What breaks.** Since #1972, Kubernetes Compute applies dedicated OpenClaw's
`main` Agent rules to dedicated Codex. Deployment answers `400` naming the
setting when the Configuration has:

- `agents.entries` without a `main` entry, for example
  `Dedicated Codex serves the main Agent: add agents.entries.main, or rename an entry to main.`
- `agents.defaults.sessionStore.agentId` or `agents.defaults.systemAgent.agentId`
  set to another Agent.
- an `agents.entries` key that is not canonical, such as `_helper`.

The Gateway serves the Harness workspace only to `main`. Without a `main` entry,
workspace file reads and writes answered `503`; with another default Agent,
chats ran as an Agent other than the one the files page edits.

**Who is affected.** Dedicated Codex Agents whose Configuration matches one of
these. No bundled Preset does. Running workloads are not changed, but until the
Agent is deployed again with a fixed Configuration, re-preparing its active
revision reports the same refusal and skips repair. Embedded OpenClaw and SSH
Compute are unchanged.

**How to tell.** Check the Agent's Configuration for the settings above.

**Steps.** Rename the entry to `main` (or add `agents.entries.main`), set or
remove the named `agentId`, rename a non-canonical key, save the Configuration,
and deploy the Agent again. _untested_

## 2026-10-09: Configuration save refuses Agent rosters every deployment refuses

**What breaks.** Since #1959, Configuration create and update
(`POST /namespaces/<id>/configurations`, `PATCH .../configurations/<id>`,
`occ configuration create` and `update`) answer `400 INVALID_REQUEST` for an
`agents` roster that Kubernetes Compute deployment already refused on every
topology, such as an `agents.list`, an entry's `default`, or more than one
`agents.entries` entry without `agents.ownership: "explicit"`. The
[Configuration reference](../../reference/configuration.md#create-read-update-and-delete)
lists every rule. The message is the one deployment gives, naming the setting and
the rule. Such a write used to save and fail only at deploy.

**Who is affected.** Clients and scripts that save such a roster, including the
split-layout `import` below, which re-creates each exported Configuration.
Stored Configurations do not change: they still read, Kubernetes deployment still
refuses them with the same message, and an update that fixes the roster saves.
SSH Compute deployment does not check rosters, so there the save is the first
refusal. Rules that depend on the topology, such as dedicated OpenClaw serving
the `main` Agent, still apply only at deployment.

**How to tell.** On Kubernetes Compute, deploying an Agent that uses such a
Configuration already fails with a `400` naming an `agents` setting. A save now
fails with the same message.

**Steps.** Fix the roster as the message says and save again. For a split-layout
bundle, fix that Configuration's `values` in the bundle file and run `import`
again; it resumes from its ID map.

## 2026-10-09: Driver package entries are checked as Node resolves them

**What breaks.** Since #1923 and #1944, the controller picks an external Driver
package's root export, and decides whether the entry is ESM, the way Node's
`import()` does. It refuses to start, with a `drivers.<capability>.package`
message, on shapes the older loader accepted:

- A `.js` entry whose nearest `package.json` lacks `"type": "module"`, even when
  the package root has it, such as `dist/index.js` beside a `dist/package.json`
  without `type`. Node can still import that file by detecting ESM syntax; the
  controller does not. Its refusal now names the `package.json` that decided the
  format.
- A nested `package.json` that is not valid JSON or not an object
  (`has invalid package scope metadata`); the older loader ignored it.
- An export target that is extensionless (`./dist/index`), a directory, or has
  an encoded `/` or `\`; a file name with a literal `%`, which is now
  percent-decoded; and mixed subpath and condition keys, or numeric condition
  keys.

Some shapes load a different file instead of refusing: a `"."` nested inside an
array entry or condition no longer selects a file, so a later entry may load, and
the `module-sync` and `node-addons` conditions now match as in Node.

**Who is affected.** Installations that select a Driver package
(`drivers.<capability>.package`) built with one of these shapes. Built-in
Drivers and the [documented manifest](../../reference/drivers/selection.md) are
not affected.

**How to tell.** The controller exits at startup with a
`drivers.<capability>.package` message naming the problem. For a package that
uses nested `"."` keys or those conditions, check which compiled file its root
export now selects.

**Steps.** Fix the package and publish a new version: add `"type": "module"` to
the `package.json` the message names, or rename the entry to `.mjs`, and point
`exports` at the exact compiled file. Pin that version in the controller image's
dependencies, rebuild the image and upgrade.

## 2026-10-09: peer namespaces must be Kubernetes namespace names

**What breaks.** Since #1914, the controller refuses to start with
`DNS peer namespace must be a Kubernetes namespace name: a DNS label of at most
63 characters.` (or the same message for a gateway client, the repository
credential gateway, the provider Harness gateway or the managed channel proxy)
when that peer's namespace is not a DNS label (lowercase letters, digits and
inner hyphens, at most 63 characters). The observability demo chart refuses such
an `occ.namespace`, `dns.namespace` or `grafana.clients[N].namespace`.

**Who is affected.** Only a hand-written `installation.yaml` or demo chart
values with such a value. No Namespace can have that name, so the peer's
NetworkPolicy matched nothing or could not be applied: the peer was already
unreachable. The profile renderer and product charts refuse these values
already.

**How to tell.** The controller logs the message above at startup; `helm
upgrade` of the demo chart fails with the field name.

**Steps.** Set the peer's real Namespace name (`kubectl get namespaces`), then
upgrade.

## 2026-10-09: sandbox domains longer than 214 characters are refused

**What breaks.** Since #1823, Helm refuses a `gatewayRouting.sandbox.domain`
over 214 characters (`must not exceed 214 characters, leaving room for the
agent-<32 hex>. prefix`), and the controller refuses to start with
`Sandbox domain must not exceed 214 characters`. Each dedicated Agent hostname,
`agent-<32 hex>.<domain>`, must fit the 253-character Gateway API limit.

**Who is affected.** Installations with sandbox routing and a 215-253 character
domain. Their dedicated Agent preview routes were already refused at deploy.

**How to tell.**
`helm get values <release> -o json | jq '.gatewayRouting.sandbox.domain // "" | length'`
prints more than 214.

**Steps.** Pick a shorter preview domain, issue its wildcard certificate and
DNS, set the new domain, then upgrade.

## 2026-10-07: migration 0049 refuses managed ChatGPT service-account Agents

**What breaks.** Since #1648 (`94957cedc`), migration
`0049_codex_pat_sources` stops the upgrade with SQLSTATE `23514`
(`Unsupported legacy managed PAT authentication`) when any Agent, Agent
revision or queued provisioning request still uses the retired
`chatgpt_service_account` Harness auth. The method is now `codex_pat` with a
service-account source. The old release keeps running; nothing is changed.

**Who is affected.** Installations that ever deployed an Agent with
`harnessAuth.method` `chatgpt_service_account`, including Agents since changed
to another method, because their old revisions keep it.

**How to tell.** Before upgrading, on the old release:

```bash
occ agent list -o json | jq -r '.[] | select(.harnessAuth.method == "chatgpt_service_account") | .id'
```

Run it in every Namespace (`--namespace`). An Agent changed away from the method
still has old revisions; check them with
`GET /namespaces/<id>/agents/<agent>/revisions`.

**Steps.** Deleting an Agent removes its revisions and provisioning requests,
which clears the refusal.

1. Record each affected Agent's settings (`occ agent get <id> -o json`) and
   workspace files.
2. Delete it on the old release (`occ agent delete <id>`) and wait until
   `occ agent list` no longer shows it.
3. Upgrade.
4. Re-create the Agent with
   `"harnessAuth": {"method": "codex_pat", "source": {"kind": "service_account", "namespaceId": "<ns>", "id": "<sa>"}}`,
   then deploy it.

_Untested_ on a real Installation. The split-layout script below does steps 1, 2
and 4 for every Agent it moves.

## 2026-10-05: split-layout tenants block the controller upgrade

**What breaks.** Since #925 (`dd344a97c`), a single-cluster Installation keeps
each Namespace's Gateways and Harnesses in one tenant namespace. Releases before
it kept Gateways in a separate `oce-gateways-<hash>` namespace. The current API
and worker refuse to start while such a namespace exists, and the
[image upgrade helper](production-upgrade.md) stops at its startup preflight
(`Existing split-layout Gateway storage prevents this single-cluster upgrade`)
before it changes anything. See
[split-layout installations](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations).

**Who is affected.** Single-cluster Installations created by the 2026-09-28
release, or by any main before `dd344a97c`, with at least one Namespace.
Bootstrap creates `default`, so that is nearly all of them. The experimental
two-cluster profile is not affected.

**How to tell.**

```bash
kubectl get namespaces -l openclaw.dev/gateway-namespace -L openclaw.dev/namespace
```

A row with an empty `NAMESPACE` column is a split-layout tenant.

**What you lose.** No migration moves the old namespaces, so their tenants are
exported, deleted and re-created under new IDs. A deleted Namespace's name stays
reserved, so each Namespace comes back under a new name. These come back:
Secrets (you supply the values again), Configurations that an Agent uses,
Presets, credential sources, Roles, access bindings, service accounts (without
issued credentials) and Agents. Agents that were running are deployed again,
and a copy of each running Agent's Harness workspace can be put back. These do
not come back:

- chat history and other Gateway state (the copy keeps the transcripts for
  reference; loading them into the new Gateway is untested);
- Agent revision history and bindings to old revisions;
- group, Installation-wide and resource-less bindings (re-create them by hand);
- issued service-account credentials and Agent runtime credentials;
- the old IDs and Namespace names, so update anything outside OCE that uses them.

Accounts, Installation service keys and the audit history stay in the database.

**Steps.** Tested on a 2026-09-28 release Installation with three Namespaces
and three Agents: the commands took about two minutes, plus the two image
releases (about 35 seconds each). Run them from a checkout of the target
release, with `occ` set up for the old release as an administrator (`OCC_URL`,
`OCC_SERVICE_KEY_FILE`, `OCC_CA_BUNDLE`) and `kubectl` for the cluster. The
script talks to OCC only. Keep every file below private: they hold
Configurations, workspace files, transcripts and Secret values.

1. Export every Namespace from the old release:

   ```bash
   node scripts/split-layout-tenants.mjs export --out /secure/occ/tenants.json
   ```

   If a successful API response is malformed or lacks its data envelope, export
   exits nonzero without writing a bundle. Restore the API response path and
   rerun export, then check its Namespace inventory before continuing.

   It reads `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md` only where
   [workspace routing](workspace-routing.md) is configured and the Agent runs.
   Step 2 copies the whole workspace instead.

2. Copy each running Agent's Harness workspace and Gateway state:

   ```bash
   ARCHIVE=/secure/occ/tenant-archive
   mkdir -m 700 -p "$ARCHIVE"
   kubectl get pods -A -l openclaw.dev/agent --field-selector status.phase=Running -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.name} {.metadata.labels.openclaw\.dev/workload-role} {.metadata.labels.openclaw\.dev/agent}{"\n"}{end}' |
   while read -r ns pod role agent; do
     case $role in
       gateway) paths='.openclaw/state .openclaw/agents/main/agent .openclaw/media .openclaw/agents/main/sessions' ;;
       agent) paths='workspace .codex/generated_images' ;;
       *) continue ;;
     esac
     kubectl -n "$ns" exec "$pod" -c "$role" -- tar -C /home/node --ignore-failed-read \
       --exclude=codex-home --exclude='.oce-workspace-setup.*' -cf - $paths \
       >"$ARCHIVE/$agent-$role.tar" </dev/null || echo "failed: $agent $role"
   done
   ```

3. Write the Secret values to a `0600` file such as
   `/secure/occ/tenant-secrets.json`, keyed by the old Namespace name, then
   Secret name: `{"team-a": {"model-key": "..."}}`. List the names with
   `jq '.namespaces[] | {name, secrets: [.secrets[].name]}' /secure/occ/tenants.json`.
4. Delete the tenants on the old release. The command refuses if a Namespace
   gained an Agent or Secret after the export, or if the export could not read an
   Agent's workspace files; once step 2 has the copy, add
   `--allow-unread-workspace-files`:

   ```bash
   node scripts/split-layout-tenants.mjs discard --bundle /secure/occ/tenants.json \
     --yes --allow-unread-workspace-files
   kubectl get namespaces -l openclaw.dev/gateway-namespace
   ```

   Continue when no `oce-gateways-*` namespace is left. A Configuration that no
   Agent uses is not exported and blocks its Namespace's delete; the error says
   how to find and delete it. Then run `discard` again.

5. [Upgrade the control plane](production-upgrade.md#upgrade-the-control-plane)
   and the runtime as usual. The preflight now passes.
6. Re-create the tenants under new Namespace names. `--skip` leaves out a
   Namespace you no longer need, such as an unused `default`:

   ```bash
   node scripts/split-layout-tenants.mjs import --bundle /secure/occ/tenants.json \
     --secret-values /secure/occ/tenant-secrets.json --map /secure/occ/tenant-ids.json \
     --rename team-a=team-a-2 --skip default
   ```

   It creates the Namespaces and exits `3` until they are `ready`.
   [Grant tenant RoleBindings](production-agents.md#grant-tenant-rolebindings)
   for each one, then run the same command again. The ID map records every old
   and new ID, so a rerun after any failure resumes. Exit `4` lists what needs a
   hand: Agents whose deploy failed, such as a service-account Agent without an
   issued credential, and access bindings it could not re-create.

7. Put each Harness workspace back once the new Agent's Harness Pod runs:

   ```bash
   for tarball in "$ARCHIVE"/*-agent.tar; do
     old=$(basename "$tarball" -agent.tar)
     new=$(jq -r --arg old "$old" '.ids[$old] // empty' /secure/occ/tenant-ids.json)
     [ -n "$new" ] || { echo "skipped: $old was not imported"; continue; }
     read -r ns pod < <(kubectl get pods -A --field-selector status.phase=Running \
       -l "openclaw.dev/agent=$new,openclaw.dev/workload-role=agent" \
       -o jsonpath='{.items[0].metadata.namespace} {.items[0].metadata.name}')
     [ -n "${pod:-}" ] || { echo "skipped: $new has no running Harness"; continue; }
     kubectl -n "$ns" exec -i "$pod" -c agent -- tar -C /home/node --no-overwrite-dir -xf - <"$tarball" \
       && echo "restored $old -> $new" || echo "failed: $old -> $new"
   done
   ```

8. Check the Agents (`occ agent list`) and re-issue any service-account
   credentials.

## 2026-10-01: released dedicated Agents fail to redeploy

**What breaks.** Since `7e831ba37`, the dedicated Harness init container makes
its `workspace` and `generated-images` directories private (`0700`). Agents
deployed by the 2026-09-28 release have those directories owned by root, so on
the first redeploy the init container fails with `EPERM` and the Harness stays
in `Init:Error`. The upgrade helper's runtime step redeploys every running Agent.

**Who is affected.** Installations whose dedicated Agents were deployed by the
2026-09-28 release and are redeployed by a controller from `7e831ba37` up to,
but not including, #1652 (`42c43fcd0`, 2026-10-09).

**How to tell.** The Harness Pod's `prepare-private-state` container exits with
`EPERM: operation not permitted, chmod '/harness-workspace-state/workspace'`.

**Steps.** Upgrade the controller to `42c43fcd0` or later, then deploy the
Agent again (`occ agent deploy <id>`). The init container moves each old
directory aside, recreates it as uid 1000 with mode `0700` and moves the files
back. Entries it cannot move back are left in `.workspace.kubelet-created` or
`.generated-images.kubelet-created` beside it and named in the init log.

# Earlier breaking-change notices

These [breaking-change notices](breaking-changes.md) are dated before
2026-10-09. They still apply when you upgrade from a source commit older than
their date. Entries are newest first. Steps marked _untested_ have not been run
against a real Installation.

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
it kept Gateways, their state and the canonical Secrets in a separate
`oce-gateways-<hash>` namespace. The current API and worker refuse to start
while such a namespace lacks the tenant label, and the
[image upgrade helper](production-upgrade.md) stops at its startup preflight
(`Existing split-layout Gateway storage prevents this single-cluster upgrade`)
before it changes anything. See
[split-layout installations](../../reference/drivers/kubernetes-compute.md#existing-split-layout-installations).

**Who is affected.** Single-cluster Installations created by the 2026-09-28
release, or by any main before `dd344a97c`, with at least one Namespace.
Bootstrap creates `default`, so nearly all are. The experimental
two-cluster profile is not affected.

**How to tell.**

```bash
kubectl get namespaces -l openclaw.dev/gateway-namespace -L openclaw.dev/namespace
```

A row with an empty `NAMESPACE` column is a split-layout tenant.

**Steps.** Adopt each tenant in place with the
[split-layout upgrade](split-layout-upgrade.md): each `oce-gateways-<hash>`
namespace becomes its tenant's namespace, and IDs, Namespace names, revisions,
Secrets, service-account credentials, chat history and Harness workspaces all
stay. Tenants that can't be adopted use the export fallback on the same page,
which re-creates them under new IDs.

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

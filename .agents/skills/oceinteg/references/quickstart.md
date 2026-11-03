# Verify the installation quickstarts

Run `oceinteg quickstart` to replay the current quickstarts against a fresh
installation and verify the same dedicated OpenShell Codex Agent through
OpenClaw. This is an agent workflow. It is not a shell command or a replacement
for the broader [main acceptance scenario](./main.md).

## Resolve the run

Select local k3d, an existing Kubernetes cluster, Amazon EKS, or an explicitly
requested set. Record source/chart/image versions, cluster/context, owned
resources, timeouts, and whether the Agent must remain running. Use a fresh
private run directory and isolated database for each replay. Keep any private
operator runbook and credential locations outside the repository and evidence.
Read [Supply credentials](./credentials.md) before retrieving or transferring
anything. Confirm the connected Codex account, authorized model, known Linear
team or issue, GitHub App and installation, authorized repository, and one unique
test branch. Resolve authorization before provisioning or attempting a push.

The scenario creates an installation and Agent, sends model and Linear reads,
and makes one empty Git commit on the approved test branch. EKS infrastructure
creation, cost, account and region require their own authorized scope. Retention
and deletion must follow the resolved run inputs.

## Follow the current guides

1. Follow the selected setup reference:
   [local k3d](./setup-k3d.md), [Kubernetes](./setup-kubernetes.md), or
   [Amazon EKS](./setup-eks.md). The user-facing guide owns the commands.
   Do not substitute an old installer or change runtime Drivers to repair the run.
2. Complete Control UI onboarding on the setup Agent. Confirm the identity and
   preference were saved, `BOOTSTRAP.md` was removed, and a real model reply
   succeeded. Close and reopen the same conversation and ask for the preference
   without repeating it. Record the Agent ID, revision ID, browser path and
   selected model without recording credentials.
3. Save and reload the guide's private `session.sh` in a fresh Bash shell. Verify
   its recorded kubeconfig/context and IDs still select the same installation
   and Agent. Use the shared [operator session](../../../../docs/guides/deploy/quickstart-session.md)
   instead of copying platform-specific helpers between installations.
4. Follow [Add Plugin](../../../../docs/guides/integrations/codex-plugins.md).
   Enable Linear on that Agent, deploy through the guide's Console or CLI path,
   and verify a successful tool read against the known permitted resource.
   Compare actual tool output with the reply and an independent authorized read.
   If display history omits the result, use the documented transcript fallback
   for the existing marked run. Do not resend the prompt merely to get evidence.
5. Follow [Add Git](../../../../docs/guides/repository-credentials/openshell-git-push.md)
   on the same Agent. Preserve Linear and its model source. Make the one approved
   empty commit through native Git invoked by an OpenClaw turn. Independently
   verify the remote branch SHA, parent, tree and App bot identity. Save a scoped
   Credential Proxy `receive-pack` receipt for that Agent revision using the
   guide's `git_audit` helper. An operator Git operation cannot stand in for the
   Agent push.
6. Follow [Restore read-only Git](../../../../docs/guides/repository-credentials/openshell-read-only.md).
   Verify the write token's recorded retirement and absence of sealed material,
   then verify an authenticated Git read on the replacement revision. Reopen the
   original browser conversation, check the saved preference, and repeat a real
   Linear read so both capabilities are proved on the resulting Agent.

Git and plugins may be added in either order. For a run claiming both orders,
repeat the procedure on a separate fresh installation with the order reversed;
record each result separately. Natural Git token renewal is an optional
[additional proof](../../../../docs/guides/repository-credentials/openshell-git-renewal.md),
not a substitute for the first verified push.

## Evidence, failures and completion

Report one row per topology with passed, failed, blocked or not-run results for
installation, browser onboarding, same-chat recall, Linear tool read, native Git
push, remote commit verification, write retirement, read-only Git and the final
Linear read. Record exact Agent/revision IDs and workload image digests. Keep
sanitized turn/tool/run IDs, resource facts, Git refs and receipts privately.
Fixtures, rendered templates, installed plugins and ready Pods alone do not prove
these assertions. Do not transfer a local pass to EKS.

For every instruction failure, record the guide path/step and commit, observed
error, cause, workaround, owning documentation or code fix, and clean replay
result. Read back state after an uncertain mutation before retrying. A repaired
live environment does not prove the original procedure. Preserve failed evidence
and keep acceptance incomplete until required assertions have evidence.

If retention was selected, leave the same Agent running with read-only Git and
Linear, its persistent workspace, and necessary access processes. Record the
Git grant deadline and exact resume instructions. Closing a laptop forward ends
browser connectivity. If disposal was selected, use [Delete Agent](../../../../docs/guides/deploy/quickstart-delete-agent.md)
then the selected [k3d](../../../../docs/guides/deploy/local-cleanup.md),
[Kubernetes](../../../../docs/guides/deploy/kubernetes-cleanup.md), or
[EKS cleanup](../../../../docs/guides/deploy/eks-cleanup.md) guide. Honor its
credential-expiry warning and inventory retained cloud resources and charges.
Preserve preexisting credential sources and remove only run-owned copies whose
consumers are gone.

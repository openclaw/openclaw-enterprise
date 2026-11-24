# Choose repository access in the console

Repository choices for [Create Agent](create-and-deploy.md#create-an-agent) and
the **Repositories** tab of a new version draft: discovery, access levels, policy
checks, and recovery after a failed or rejected save.

## Discover and select repositories

Leave repositories unselected for a model-only Agent, including when a Git
Credential Proxy is configured. Selected repositories require approved access
and their configured enforcement.

When eligible **Per-repository access** choices are available and none is selected,
**Create Agent** warns if it will request deployment without a repository policy.
Select a repository to **Save Agent draft** with its access instead. Saving a
draft does not deploy it. If the first deployment has no repository policy, adding
**Per-repository access** later requires a new Agent. A saved policy that allows
no repositories still counts as a policy. An eligible Dedicated Codex draft shows
this conditional warning when **Deploy new version** is available and no saved
repository policy has been confirmed.

Repository discovery is independent of model authentication. Small catalogs offer
**Add**; larger ones support search and paging.
Suggestions favor repositories you recently saved in this browser and Namespace,
then sort alphabetically.

If there are no approved repositories or a search has no matches, ask your
Namespace operator about missing repositories.

**Default repository access** starts at **Contributor** for code pushes, PRs,
and issue management. Choose **Read-only**, or customize Contributor to turn off
issue management. Added repositories inherit the default; expand a repository card
to choose a custom level or **Use Agent default** to restore inheritance. Custom choices stay
fixed when the default changes, even if they matched it. Invalid combinations stay
visible and must be repaired or removed before saving. Overrides never widen silently.

The server resolves selections against current Namespace policy on save and
deployment. Push and PR permissions remain bundled; see
[access levels](../repository-credentials/access-levels.md) for token permissions,
merges, and the API contract. Edit saved drafts in **Open draft** >
**Repositories**; saved versions stay unchanged. Save or cancel edits before navigating away.

Failed rediscovery keeps unsaved repository choices for retry and
navigation in explicitly selected Preset forms.
**Create Agent** stays blocked until discovery succeeds and filters choices against
current policy, except in the fallback states below.

After `503 REPOSITORY_OPTIONS_UNAVAILABLE`, or when the Installation has no
repository settings (`meta.notConfigured`), **Create Agent** can proceed without
repository bindings if no selections remain. When guided provisioning is available,
it can still request immediate deployment. Remove retained selections to continue.
The **Repositories** tab offers **Save** only for an edit that removes every
repository, which drops stale bindings. Other failures, including generic `503`,
throttling and connection errors, leave repository access unverified, block both writes, and offer retry. Denial and
Namespace lifecycle conflict remain distinct. Each subsequent write rechecks
authorization.

After a known repository-scoped Agent rejection, **Reload repository choices** clears
selections/search, resets pagination, reveals results, and refreshes Namespace
policy while retaining the Configuration. Retry requires an approved repository;
an empty catalog cannot convert the attempt to an ordinary Agent. Failed reloads
disable creation and show the Configuration ID. Expiry returns to sign-in.
**Start a new draft** preserves the saved Configuration.

## Recover a repository edit or save

When you return to the browser tab or refocus the window, the Console rechecks the
session, Namespace, Agent, and editing permissions. If the same session and access
are confirmed and the view can be reused, unsaved repository edits remain. A changed
Configuration or narrower access can rebuild the view. If the permission check is unavailable,
the Console retains the edits and hides the chooser. **Retry access check** repeats the
foreground checks without saving. If the check interrupted a Save before it was sent,
select **Save repository access** again after access is confirmed.

A confirmed denial removes the chooser and unsaved edits. If the Agent remains readable,
the Console shows its saved selections read-only. Session expiry or a changed user or
session clears private state.

Save rereads the Agent and waits for overlapping foreground checks. If either read shows
changed repository access or a changed Configuration, no PATCH is sent; use **Reload draft**.
A later writer can still race the PATCH. Dirty edits and pending or unresolved saves block
navigation and deployment. **Account → Settings** keeps the editor open while guarded;
after a successful save, Settings opens normally.

If update access is denied after the PATCH starts, the Console removes the chooser but
keeps the save guard. A confirmed success reads the same Agent again. A known rejection
says the write was not saved and requires **Reload draft**. If the outcome is unknown,
inspect saved access with **Reload draft** before another save. If **Reload draft** is
disabled, retry the access check first. A transient reload failure keeps the guard and
offers **Reload draft** again. A denied Agent read retires the protected view. Restored
update access alone does not reopen an unresolved editor. Recovery reads saved access and
does not repeat the PATCH.

## Use repositories and Slack on the same Agent

Select **Codex**, **Dedicated**, the approved repositories and an explicit access level.
Configure Slack and select its saved token Secrets in the creation form, then
choose a compatible model-authentication source. **Per-repository access** saves
the Agent and its access as a draft for review before deployment. With **Access
profiles**, supported provisioning, and successful discovery, **Create Agent**
follows setup and deployment. The worker creates Configuration and Agent, grants
final Secret access, and provisions transport credentials.
Check that the returned Agent revision belongs to this Agent and retains its repository
selections. An ordinary draft requires model and channel credential setup and **Deploy new version**
from its detail page.

Operators must prepare the
[repository installation](../../guides/repository-credentials/installation.md),
Namespace approvals, runtime images, networking, model credential and exact-Agent
grant, plus a Slack app with Socket Mode and channel membership. Slack requires a
[channel proxy](../drivers/kubernetes-compute/networking-and-isolation.md).
Verify this Agent and version: admission proves neither channel connectivity nor
repository operations. Repository permissions do not change Harness filesystem or
approval policy; review both before demonstrating edits.

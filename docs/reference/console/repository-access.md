# Choose repository access in the console

Repository choices for [Create Agent](create-and-deploy.md#create-an-agent) and
the **Repositories** tab of a new version draft: discovery, access levels, policy
checks, and recovery after a failed or rejected save.

## Discover and select repositories

Repository discovery is independent of model authentication. Small catalogs offer
**Add**; larger ones support search and paging.
Suggestions favor repositories you recently saved in this browser and Namespace,
then sort alphabetically.

**Default repository access** starts at **Contributor** for code pushes, PRs,
and issue management. Choose **Read-only**, or customize Contributor to turn off
issue management. Added repositories inherit the default; expand a repository card
to choose a custom level or **Use Agent default** to restore inheritance. Custom choices stay
fixed when the default changes, even if they matched it. Invalid combinations stay
visible and must be repaired or removed before saving. Overrides never widen silently.

The server resolves selections against current Namespace policy on save and
deployment. Push and PR permissions remain bundled; see
[access levels](../repository-credentials/access-levels.md) for token permissions,
merges, and the API contract. Edit saved drafts in **Create new version** >
**Repositories**; saved versions stay unchanged. Save or cancel edits before
navigating away; returning to the tab can refresh the session and discard them.
An interrupted save may complete; inspect the saved draft before retrying.

Failed rediscovery keeps unsaved repository choices for retry and
navigation in explicitly selected Preset forms.
**Create Agent** stays blocked until discovery succeeds and filters choices against
current policy.

Only `503 REPOSITORY_OPTIONS_UNAVAILABLE`, or an Installation without repository
settings (`meta.notConfigured`), with no selected repositories permits saving a draft; provisioning requires successful discovery.
Remove retained selections to continue there. The **Repositories** tab then offers
**Save** only for an edit that removes every repository, which drops stale bindings.
Other failures, including generic `503`, throttling and connection errors, block
both writes and offer retry. Denial and Namespace lifecycle conflict remain
distinct. Each subsequent write rechecks authorization.

After a known repository-scoped Agent rejection, **Reload repository choices** clears
selections/search, resets pagination, reveals results, and refreshes Namespace
policy while retaining the Configuration. Retry requires an approved repository;
an empty catalog cannot convert the attempt to an ordinary Agent. Failed reloads
disable creation and show the Configuration ID. Expiry returns to sign-in.
**Start a new draft** preserves the saved Configuration.

## Use repositories and Slack on the same Agent

Select **Codex**, **Dedicated**, the approved repositories and an explicit access level.
Configure Slack and select its saved token Secrets in the creation form, then
choose a compatible model-authentication source. With supported provisioning and successful repository discovery, **Create Agent**
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

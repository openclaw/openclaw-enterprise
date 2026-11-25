# Review policy denials and change one Agent's network access

## Repository access

To change one Agent's access, choose **Edit repository permissions** on its Configuration snapshot
or open its version draft and choose **Repositories → Manage permissions**.
Save the first repository policy before you deploy. An Agent previously deployed without one needs a new Agent ID to use these controls.

1. Enable policy editing if prompted. Choose **Add access** beside the repository you want.
2. **Contributor** is the default where Write is permitted. The Agent can push code, open pull requests and create issues within its approved GitHub permissions. Choose **Read-only** to prevent direct writes.
3. For example, to keep push access and prevent direct issue creation, open **Advanced** and set **Issues** to **Read-only**. Leave **Pull requests** on **Use role**. A limit persists even when current permissions already block that operation.
4. Choose **Save repository policy** and deploy the new version. Saving alone leaves the running version unchanged. Manage permissions compares the saved policy with the active version. When reducing access, verify retirement of the previous Sandbox.

**No access** blocks direct requests for a resource. To block unlisted resources, including future ones,
select **Allow only explicit API selections**. Choose which resources to allow. Git access stays the same.
**Reset to role defaults** removes these limits for this Agent and repository.

[Namespace limits and GitHub permissions](../../reference/repository-credentials/access-levels.md#native-git-delivery) apply to every Agent using the registration. If a bound repository has no grant, the Agent can't open PRs anywhere. Unbind an unused repository and redeploy.

## Network denials

Open an Agent in the OCE console, select its running version, and choose
**Policy denials**. You need the Agent's existing Sandbox log permissions to see
observed denials. A version that runs without a Sandbox records none, and the tab
says so. On an Installation that selects no Sandbox Driver, the tab says that
instead, and policy changes, including turning editing on, are refused. Policy reads and changes have independent permissions; see the
[policy reference](../../reference/sandbox-policies.md).

1. Check the **Network policy** card above the log. **Policy details** shows saved
   and confirmed live versions and read-only Installation defaults. **Deployed**
   means the version runs the saved policy it was deployed with and no live change
   was requested. **View network
   limits** opens the Installation ceiling, which grants no access by itself.
   Suggestions are untrusted candidates. The card shows three at a time; **Show all**
   expands the list. Expand **Full executable path** before reviewing a suggestion.
   With editing off, **View suggestions** still lets you inspect candidates.
2. Read the denial count and any gap notices. The log starts with five rows per
   page. Search the loaded window or use **Next** to inspect more records. Expand
   a row for decision metadata and its sanitized log. Missing fields stay unknown.
   **Follow** collects updates without moving the rows you are inspecting; select
   **Show newest** to display them.
3. Choose **Allow this** for one denial, or select several and choose
   **Allow selected**. **Select page** selects eligible rows on the visible page.
   Selection carries across pages; the count includes selections outside the
   current page. Exact executable, host, and port requests become proposed rules.
   Repeated requests and requests covered by saved or proposed rules do not add
   duplicate rules. Incomplete metadata cannot prefill a rule. A denial that
   names only OpenShell's placeholder address, without the record of its
   hostname, reads **Hostname not logged** and proposes nothing.
4. Administrators can use the **Policy editing** switch beside **Manage rules**.
   Its **On** or **Off** label states the current setting. Disabling editing preserves
   saved rules. **View rules** remains available with editing off. To change rules,
   enable editing and choose **Manage rules**. Search or page through five rules at
   a time. Use **Add rule** or a row's menu to edit or remove a rule. These changes
   stay local. The dialog footer offers **Review changes** when the draft changes;
   **Done** closes without saving and retains the proposal on this page.
5. Select **Review changes** after editing a rule. A batch opens this review
   directly. Check the rules to add, update, or remove. The preview shows field
   errors without saving or applying. **Back to editing** retains the proposal.
6. Choose **Save for later** to persist the policy without changing the current
   revision, or **Save and apply to current revision** to save the reviewed rules and queue
   their application together. Wait for **Applied** before retrying the original tool action.
   A successful tool result provides the final execution evidence.
   If the combined response is lost, the Console reads the policy again. If that
   read fails, select **Refresh policy** in the editor to see the saved version
   and application status before making another change.
7. To apply a policy saved earlier, choose **Apply saved rules** on the card or
   in the **Manage rules** footer. This action is unavailable while the proposal
   has unsaved edits. **Applying…** waits for provider confirmation. If application
   is unconfirmed, use **Refresh status** to read the outcome without submitting
   another request. If the refreshed application still failed, **Retry application**
   offers a separate explicit request to authorized users. When live application
   is unsupported, use **Deploy new version** explicitly. Deployment requires deploy
   permission and can interrupt the Agent.

The schema supplies field descriptions and constraints. Shapes without a form
use a schema-aware JSON editor. A preview for an older draft or policy version
cannot replace newer edits. An addition outside the ceiling is rejected with a visible error. Correct the
retained edit and review it again; the saved policy remains unchanged and no
application is requested. If the running revision changes before
OCC accepts a combined save and apply, refresh the Agent and review the edit again.
If the request outcome is uncertain, refresh the saved version and application
status before submitting another change.

An administrator must first enable editing for the Agent and separately grant
exact-Agent `manage_policy` and exact-SandboxPolicy `update`. Viewing the policy
and live application also need exact-SandboxPolicy `read`, as do deploying and
updating an Agent with a repository binding while it has saved grants. Enabling editing
alone grants none of these permissions. The ordinary editor cannot alter Installation
or generated rules. Disabling editing preserves approved grants. To remove
access, re-enable editing if needed, remove the addition, and apply or deploy it.

If a read fails, retry that read. Manual policy editing remains available when
logs or recommendations are unavailable. If saving reports a stale version,
refresh and review the current additions. When the running or next version uses
protected execution (the Credential Proxy), saving additions and deploying with them
are refused with `SANDBOX_POLICY_PROTECTED_EXECUTION`, as is live application to a
protected version; the editor says so and offers only removal of saved rules. With OpenShell Git, an Agent
with a repository binding cannot add a grant for `github.com` or any name under it
(any port or matching wildcard), or for an IP address, which may lead to GitHub:
GitHub goes only through the Git route, so save, binding, deploy and apply refuse
it and name the grant. After a timeout or unconfirmed
application, refresh and inspect the recorded state before another explicit
request; do not assume the provider rejected the change.

## CLI

Use the same Namespace and authenticated OCC context as other Agent commands.
Get the current saved policy version and the ID of the active revision before
preparing a change. The active revision is `activeRevisionId` in the Agent's
JSON output, which needs only Agent read.

```sh
occ agent policy get AGENT_ID --facet networking -o json
occ agent get AGENT_ID -o json
```

To save a replacement and queue its application in one request, create
`apply.json` as the [HTTP request body](../../reference/api.md#post-namespacesnamespaceidagentsagentidsandboxpolicyfacetapply).
Set `revisionId` to the active running revision ID and `expectedVersion` to
the current saved policy version. Include the complete desired `additions`
array. An empty array clears Agent-specific grants. Omit `additions` to apply
the saved version. This example clears the existing Agent-specific grants.

```json
{
  "revisionId": "rev_33333333-3333-4333-8333-333333333333",
  "expectedVersion": 2,
  "additions": []
}
```

```sh
occ agent policy apply AGENT_ID --file apply.json
```

To save a replacement for later, use `update` with `additions.json`
containing the current `expectedVersion` and the complete `additions` array.

```sh
occ agent policy update AGENT_ID --file additions.json
```

To apply a saved policy, read the current saved version again with
`occ agent policy get AGENT_ID` and confirm the active revision. Pass that
version and revision ID together without `--file`.

```sh
occ agent policy apply AGENT_ID --revision REVISION_ID --expected-version VERSION
```

OCC returns HTTP 202 when it queues the application. The CLI prints the policy
record with `application.state` set to `pending`. Keep the application ID,
revision ID and policy version from that response. Run
`occ agent policy get AGENT_ID` and match all three fields in
`policy.application`. Wait for that application’s state to become `applied`.
If you lose the response or see a different application, reconcile the original
request before submitting another change.

An authorized administrator can enable editing with
`occ agent policy editing AGENT_ID --enabled=true`. Policy commands print
JSON by default. Use `-o yaml` for YAML. Policy reads show saved Agent rules
and admitted or Driver defaults. Generated model and Git rules can still apply
when the arrays are empty. See [Local Setup policy files](../deploy/local-sandbox-network-policy.md)
for defaults and operator ceiling inputs.

## Set GitHub access before the first deployment

In **Create Agent → Repository access**, check the repositories the Agent needs.
For administrators who can read policies, a new empty picker defaults to
**Per-repository access** when eligible GitHub repositories are available.
Presets retain their selections. With no boxes checked, **Create Agent** saves
no repository policy and can deploy immediately. To save an explicit deny-all
list, use the policy editor on an undeployed draft. Once an Agent has deployed
without a list, including with **Access profiles**, you need a new Agent to
use per-repository access.

Check each owner/name and choose **Read-only Git** for clone and fetch or
**Read/write Git** if the Agent needs to push. These grants cover Git
transport. [GitHub App access](../repository-credentials.md#set-github-app-access-for-an-openshell-agent)

With one or more repositories selected, choose **Save Agent draft**. The Agent
and its grants are saved together, with policy editing off. This requires
Installation and Agent administration, permission to manage, read and update policy,
a dedicated Codex Agent with a supported model Credential Source, and a GitHub
App Client available to its Namespace.
If saving is refused, the Configuration and model credentials
can remain saved. If the Console cannot confirm the grants, do not deploy.
Select **Recheck saved GitHub access** to read the same draft again.

Check the grants shown beside **Deploy new version**. Choose **Edit repository permissions** to adjust the saved grants.
Close the dialog to change repository selections. The credential profiles listed
in Configuration do not override the saved network policy. If the policy changes
before deployment, the Console stops the request. Select **Review saved GitHub
access** and check the current grants before you deploy again.

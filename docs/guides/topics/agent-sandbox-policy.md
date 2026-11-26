# Review policy denials and change one Agent's network access

## Repository access

For native OpenShell Git, open the Agent draft's **Repositories** settings.
Select its GitHub App Client, repositories, and **Read-only Git** or
**Read/write Git** for each. Save the draft, then stop any active managed
revision before deploying. OCC derives the Git rules from those choices.
Clear the repository selections to withdraw running Git access.

Use an Agent draft without a separate repository network policy. A manually
saved list, including an empty list, conflicts with Source-backed Git.
[GitHub App setup and access levels](../repository-credentials.md#set-github-app-access-for-an-openshell-agent)

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
refresh and review the current additions. After a timeout or unconfirmed
application, refresh and inspect the recorded state before submitting another
request.

Live application is unavailable while the active revision uses the Credential
Proxy. Clearing additions updates the saved policy. To remove the running
revision's access, stop the Agent and wait for Stop to complete. You can then
edit the saved rules and deploy a new version.

Deployment checks the rules against the Installation ceiling and the Sandbox
Driver's policy. For native Git, the Credential Proxy also rejects any rule
that overlaps an admitted Repository credential route.

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

OCC returns HTTP 202 when it queues the application. From the CLI’s `apply`
output, record `application.id`, `application.revisionId` and
`application.policyVersion`. Run `occ agent policy get AGENT_ID` and match
those three fields in `policy.application`.

Poll only while the matching application is `pending`. Stop at `applied` or
`failed`. After a failure, check `policy.application.reason` against the
[reason codes](../../reference/sandbox-policies.md#desired-and-applied-versions).
The provider may have applied the policy. If the outcome is unconfirmed, the
response was lost, or the application is missing or no longer matches,
reconcile the original request before submitting another change.

An authorized administrator can enable editing with
`occ agent policy editing AGENT_ID --enabled=true`. Policy commands print
JSON by default. Use `-o yaml` for YAML. Policy reads show saved Agent rules
and admitted or Driver defaults. Generated model and Git rules can still apply
when the arrays are empty. See [Local Setup policy files](../deploy/local-sandbox-network-policy.md)
for defaults and operator ceiling inputs.

## Set GitHub access before the first deployment

In **Create Agent → Repository access**, choose the registered GitHub App
Client and the repositories the dedicated Codex Agent needs. Use **Read-only
Git** for clone and fetch. Choose **Read/write Git** when the Agent needs push
access. These grants cover Git transport.

Choose **Save Agent draft**. Confirm the saved access before deploying. If the
Console cannot confirm it, select **Recheck saved GitHub access** and review
the draft again. Deployment rechecks current approval and refuses a stale
policy version. [GitHub App setup](../repository-credentials.md#set-github-app-access-for-an-openshell-agent)

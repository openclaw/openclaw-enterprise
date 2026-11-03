# Review policy denials and change one Agent's network access

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
   revision, or **Save and apply to current revision** to save and request live
   application. Wait for **Applied** before retrying the original tool action.
   A successful tool result provides the final execution evidence.
   If the Console cannot confirm which rules were saved, open **Manage rules**,
   select **Refresh policy**, and inspect the saved version before applying it.
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
application is requested. If saving succeeds but application is rejected, the
error identifies the saved version. Refresh and inspect the current revision
before retrying application; the saved change has not been rolled back.

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

Use the same Namespace and authenticated OCC context as other Agent commands:

```sh
occ agent policy get AGENT_ID --facet networking -o json
occ agent policy editing AGENT_ID --enabled=true
occ agent policy update AGENT_ID --facet networking --file additions.json
occ agent policy apply AGENT_ID --revision REVISION_ID --expected-version 2
occ agent policy get AGENT_ID --facet networking -o json
```

The `occ agent policy` commands print JSON by default. Use `-o yaml` for YAML.
These commands return the complete policy or application result rather than a table.

`additions.json` contains `expectedVersion` and the complete desired `additions`
array. Get the current version first; an empty array removes Agent-specific
grants. The apply command returns an acknowledgement; poll `get` to observe
confirmation. See [Local Setup policy files](../deploy/local-sandbox-network-policy.md)
for defaults and operator ceiling inputs.

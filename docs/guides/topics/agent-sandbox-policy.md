# Review policy denials and change one Agent's network access

Open an Agent in the OCE console, select its running version, and choose
**Policy denials**. You need the Agent's existing Sandbox log permissions to see
observed denials. A version that runs without a Sandbox records none, and the tab
says so. Policy reads and changes have independent permissions; see the
[policy reference](../../reference/sandbox-policies.md).

1. Read **Denials in the loaded window** and any gap notices. Expand a row for
   decision metadata and its sanitized log. Missing binary, destination, reason,
   or generation information is shown as unknown.
2. If available, inspect **Policy suggestions** separately. Their observation
   counts are aggregated provider data. Choose **Review suggestion**, or enter a
   grant manually under **Agent network policy**. A denial with an exact path and
   destination can also prefill a grant.
3. In the discovered configuration section, use **Add Network rules** and
   **Remove Network rules** to edit additions. These changes stay local. Review the executable path, hostname, and complete
   port scope against the **Installation delegation ceiling**, then select
   **Review changes**. The preview shows field errors without saving or applying.
   Review the rules the controller validated. If the Console cannot read them,
   your proposal stays editable. **Back to editing** also preserves your proposal.
4. Choose **Save** to persist the policy without changing the current revision,
   or **Save and apply to current revision** to save and request live application
   to the selected running revision. Wait for `applied` and a provider version
   before retrying the original tool action. A successful tool result provides
   the final execution evidence.
   If the Console cannot confirm which rules were saved, select **Refresh policy**
   and inspect the saved version before deciding whether to apply it.
5. To apply a policy saved earlier, select **Apply saved policy to current
   revision**. This control is unavailable while your proposal has unsaved edits.
   When live application is unsupported, use **Deploy new version** explicitly.
   Deployment requires deploy permission and can interrupt the Agent.

The schema supplies field descriptions and constraints. Shapes without a form
use a schema-aware JSON editor. A preview for an older draft or policy version
cannot replace newer edits. An addition outside the ceiling is rejected with a visible error. Correct the
retained edit and review it again; the saved policy remains unchanged and no
application is requested. If saving succeeds but application is rejected, the
error identifies the saved version. Refresh and inspect the current revision
before retrying application; the saved change has not been rolled back.

An administrator must first enable editing for the Agent and separately grant
exact-Agent `manage_policy` and exact-SandboxPolicy `update`. Enabling editing
alone grants neither permission. The ordinary editor cannot alter Installation
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

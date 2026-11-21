# View direct Control UI access

A successful roster read with no configured human identities hides the entire
**Direct Control UI access** card. The reserved
`occ-workspace-files` machine identity does not count as a human. A later Access
read with human identities reveals the card again. OCC sharing stays available.
A failed or denied roster read does not establish that the roster is empty.

## View configured users

Open an Agent, select **Access**, and find **Direct Control UI access** above
**Share Agent through OCC**. These are separate access paths. Direct Gateway
teammates do not need OCC accounts; OCC sharing grants access through OCC. A
person can use both paths, but one path does not configure the other.

The direct-user list comes from the **currently serving Gateway** configuration,
not the saved Agent version selected elsewhere on the page. It excludes the
reserved OCC machine identity. Each row shows the configured identity, such as
`oidc:member-01`, with an optional native profile name and avatar. Without a name,
the identity appears on its own. A configured identity appears even before its
first connection. Gateway role labels are not OCC IAM Roles; no role is inferred
for an identity without a profile.

Search the inline list by name or identity. Choose **Refresh users** after a
configuration or profile change. Removing an identity from the Gateway allowlist
removes its row on the next read, even if OpenClaw retains the profile. The list is
read-only: manage direct admission in Gateway configuration and your external
ingress/identity provider. Use the separate OCC section to share through OCC.

Roster reads require administration permission for this Agent. The two sections
load and handle errors independently. If no Gateway is serving, its configured
users cannot be read; OCC sharing remains a separate operation. If administration
was granted after a denied read, use the page **Refresh** to retry. Automatic
revisits retain the remembered denial.

The list does not evaluate current identity-provider eligibility, enumerate active
connections, or list OCC delegated browser identities. OCC browser access uses
per-person native profiles, separately from the workspace machine identity. This
roster does not link those profiles to operator-managed identities. Config
readback does not prove that a pending change is applied. See the
[configured-user contract](../../reference/agents/gateway-people.md).

> **Trusted teammates only.** Distinct identities and roles do not provide per-person
> execution or data isolation. Withdrawing access does not guarantee cancellation
> of accepted work. Review the
> [shared-Agent trust boundary and withdrawal limits](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication)
> before inviting teammates.

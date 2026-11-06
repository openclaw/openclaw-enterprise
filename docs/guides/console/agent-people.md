# View direct Control UI access

## Save the direct-entry bookmark

On an Agent’s **Access** tab, use the optional **Direct Control UI URL** in
**Direct Control UI access** to save the operator-managed entry address. This
bookmark is shared for the Agent, not saved only in your browser. Agent update
permission is required to save, replace, or remove it; Agent read permission is
required to view it.

Enter the HTTPS address and any required path, without credentials, query
parameters, or a fragment. Save it, then use **Open direct Control UI** to open
the destination in a separate tab. The destination ingress performs sign-in.
Removing this bookmark removes only the convenience link.

OCC does not create or verify the ingress and does not change Gateway
authentication, the configured-user list, or OCC sharing. Keep the operator’s
authenticated extra ingress separate from OCE configuration. If another operator
changes the bookmark while you edit it, refresh the saved value before deciding
whether to replace it.

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
connections, or list each OCC human using the shared proxy. Config readback does
not prove that a pending change is applied. See the
[configured-user contract](../../reference/agents/gateway-people.md).

> **Trusted teammates only.** Distinct identities and roles do not provide per-person
> execution or data isolation. Withdrawing access does not guarantee cancellation
> of accepted work. Review the
> [shared-Agent trust boundary and withdrawal limits](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication)
> before inviting teammates.

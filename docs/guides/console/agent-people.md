# View people on an Agent Gateway

Open an Agent and find **People** in its overview. The card shows display names,
avatars and native OpenClaw roles for profiles already known to its Gateway,
including people who have no OCC account. The overview shows up to six people,
sorted by name. For a larger team, choose
**View all people** to open the full roster and search by display name. Close the
panel with **Close** or Escape.

Choose **Refresh people** after a new teammate connects or changes their profile.
Initials replace a missing avatar.

> **Trusted teammates only.** Profiles and roles do not provide per-person
> execution or data isolation. Withdrawing access does not guarantee cancellation
> of accepted work. Review the
> [shared-Agent trust boundary and withdrawal limits](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication)
> before inviting teammates.

Viewing the roster requires administration permission for this Agent. It is
read-only: manage Gateway access through your identity provider/ingress and roles
in OpenClaw. A listed profile does not prove current access or an active connection.
See the [Gateway people contract](../../reference/agents/gateway-people.md).

If administration was granted after a denied read, select the page **Refresh**
button to retry. Reloads and automatic revisits retain the remembered denial.

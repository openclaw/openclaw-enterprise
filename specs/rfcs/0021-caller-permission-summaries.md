---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# RFC-0021: Explain unavailable Agent actions before asking someone to confirm

A person with read-only access can open an Agent, select **Delete Agent**, and confirm
**Permanently delete Agent** before learning they lack permission. The controller correctly
refuses the deletion. We propose showing a disabled **Delete Agent** beside “Your access does
not include deleting this Agent.” The person can keep reading, and no deletion request is sent.

**Decision for API, IAM, and Console maintainers.** Publish two reads that tell the signed-in
caller whether they have a few specific IAM permissions on a resource they can already read.
Use a negative answer to explain an unavailable action. A positive answer describes one
permission at the time of the check. The controller still authorizes the actual request under
[the existing access model](0006-basic-rbac/index.md).

## What a caller can learn

The controller authorizes the read and checks that the resource exists before asking the
selected IAM Driver about the caller. Both responses use the usual `data` and `meta.requestId`
envelope and `Cache-Control: no-store`. There is no subject parameter, grant enumeration, or
access to the [administrative sharing view](0010-agent-access.md).

| Public read | Meaning of the fields in `data` |
| --- | --- |
| `GET /namespaces/{namespaceId}/agents/{agentId}/permissions` | `update`, `deploy`, `operate` (used for Stop), and `delete` each report the corresponding IAM decision on that Agent. |
| `GET /namespaces/{namespaceId}/permissions` | `agents.create` reports the Agent create decision in that Namespace, using the same target as the create operation. |

A `200` with `delete: false` is a successful read. No deletion was attempted, so the controller
adds no deletion-denial audit event. Denying the read itself produces the usual audited `403`.
An authorized read of a missing resource returns `404`. If the IAM Driver is unavailable or a
decision is invalid, return `503` for the summary so the client can distinguish unknown from false.

For example, give a caller Agent read and deploy, but no Configuration read. The permissions
read returns `200` with `deploy: true`. An actual deploy returns `403`, records a deploy denial,
and creates no revision. Each flag is evaluated separately. The response is neither an atomic
policy snapshot nor a reservation, and a client cannot use it to authorize a write.

## What happens on the page

Fetch the summary alongside the page, without making someone wait for it to read the Agent.
On the list, use `agents.create` for **Create Agent**. On an Agent, use `deploy`, `operate`,
and `delete` for **Deploy new version**, **Stop Agent**, and **Delete Agent**. Existing
[lifecycle](../plans/29-agent-stop.md) and [deletion safeguards](../plans/28-agent-deletion/index.md)
still apply.

| When the answer arrives | What the person sees |
| --- | --- |
| False, before confirmation | The action stays visible, disabled, with a specific explanation beside it. |
| False, while Stop or Delete confirmation is open | Explain the restriction in the dialog, disable confirmation, and move focus to **Cancel**. Submitting now sends no write. Advice arriving after submission cannot recall that request. |
| True, still pending, or unavailable (including an older controller) | Keep the usual control and confirmation. If the person proceeds, show the actual result, including a denial. Reload the page to pick up changed access. |

Opening a version draft is navigation. Someone with Configuration update and Agent deploy, but
no Agent update, can use **Open version draft**, save the Configuration, and submit the deploy
when its other requirements are met. Do not use `update: false` to block entry or infer access
to the draft’s editors.

## Why add these reads, and how to adopt them

Keeping the API unchanged and improving the eventual `403` would avoid new policy reads, but
would still ask a reader to confirm permanent deletion. Embedding these fields in ordinary
Agent responses would save a detail-page request, at the cost of evaluating four extra
permissions for every listed Agent. The separate reads let the Console ask only where it uses
the answer and limit what a caller can discover to the named actions.

If maintainers accept this contract, ship controller support first, then enable the Console
reads. Verify the read-only Delete experience, both confirmation timings, the split-permission
editor, and the positive deploy answer followed by a real denial. Check latency and error rate
with the selected IAM Driver: an Agent summary adds four permission evaluations beyond its read
check. If that cost is unacceptable, stop requesting summaries and keep the ordinary
confirmation and controller authorization path. No policy or stored-grant migration is required.

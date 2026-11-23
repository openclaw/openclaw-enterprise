---
published: false
---

# Namespace IAM policy documentation history

This record preserves the dated changes to the Namespace IAM policy flow. See the [parent flow](../namespace-iam-policy.md) for its context and overall sequence.

## Changelog

- 2026-11-04 12:00: Replace the built-in Roles, Group, and membership routes with the configured policy and membership at account creation; deploy grants for any Role. (claude/session_01HzmRt1DGB79VEnEWHt7PRy)
- 2026-11-04 02:25: Recheck Agent update permission under the Namespace lock. (authoring-run/fbfcb29f-156c-4cfd-af1d-fa15224dd2e5 - fdca6e74421067adc66dce4f141d153af0355f68)
- 2026-11-02 10:00: Trace Owner bindings for every create, the default Namespace binding, and the Namespace Creator setting; drop the Namespace limit. (claude/session_01HzmRt1DGB79VEnEWHt7PRy - aba993606)
- 2026-11-02 16:00: Trace parent checks that apply an exact Agent binding to the Agent's revisions and sandbox policy. (claude/session_01HzmRt1DGB79VEnEWHt7PRy)
- 2026-11-02 21:00: Trace the second authorization under the Namespace lock for creates and deploy, and the provisioning authority lock. (claude/session_01HzmRt1DGB79VEnEWHt7PRy)
- 2026-11-02 18:00: Trace the authority fence; correct the membership session hold. (claude/session_01HzmRt1DGB79VEnEWHt7PRy)
- 2026-10-30 09:02: Trace Default users membership, the Namespace owner binding, and deploy-time Agent grants; working tree changes uncommitted. (claude/session_01HzmRt1DGB79VEnEWHt7PRy - a382326dde18057a250e93a222aa8f4000477166)
- 2026-10-15 13:28: Retain assigning sessions through policy COMMIT, require transactional IAM writes, and preserve caller limits with shared guarded-session holds. (authoring-run/ec3b3e9d-0724-4b9e-a41d-4eb8a44d4851 - a302a3e2061575b64dcc37e212c55075d5c74b9a)
- 2026-10-14 11:00: Read, validate and index native policy once per State unit of work instead of once per decision. (fix-1322)
- 2026-10-01 20:30: Refuse AccessBindings whose Role cannot apply to the target. (fix-d93-d100)
- 2026-09-29 16:40: Record the Installation authorization and the Role or AccessBinding changed in IAM policy audit events. (fix-5)
- 2026-09-29 05:28: Bind selected native policy reloads to the original State transaction and reject escaped reads. (codex/01a0eb4c-5933-7752-bddc-f787e8da79e7 - 2a191c74c0079e329db130d0a81a1f0f87869bb9)
- 2026-09-27 19:15: Clarify unknown commit handling and the unregistered authority barrier. (codex/01a0b3bf-83a8-7392-ae2d-1a369b54ab3f - 181b0472f9a5a9d422035edf5121d3a15c200cb5)
- 2026-09-23 22:56: Update source ownership for extracted IAM HTTP handlers; preserve admission and transaction boundaries. (codex/01a0d075-a358-7620-8c16-fd4290acddf1 - 4df9f9800836dc1c2b57afd5f8af4d91f55088d5)
- 2026-09-23 08:44: Extend the managed grant path to existing humans and exact Namespace targets. (authoring-run/1d5da2d1-e61e-4277-bd91-037d64c10744 - 370570d788725a178a7441f8388a333c47c29798)
- 2026-09-20 09:32: Document Namespace IAM policy management flow. (codex/01a0bce5-9f29-7110-85fd-6b140674d362 - 5f7728e8c5d128bc7067b7035e07f06c3c4da92c)

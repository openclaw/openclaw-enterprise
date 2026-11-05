---
rfc: ../rfcs/0030-codex-saved-accounts.md
---

# Connect ChatGPT once for dedicated Codex Agents

- **ID:** TASK-0051
- **Status:** In progress

1. Provision the reviewed Codex template and its public client. Separate device sign-in from the browser redirect used by other templates.
2. Complete device approval into a saved connection owned by the initiating user. Have the Token Service hold the single refresh grant for that account.
3. Let the user select that connection while configuring each Agent. Enforce the grant and the provider's account identity when preparing model and hosted catalog access.
4. Exercise enrollment, cross-user access control, two-Agent reuse and independent withdrawal through the supported workflows. Record which checks reached a real provider and Harness.

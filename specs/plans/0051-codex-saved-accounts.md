---
rfc: ../rfcs/0030-codex-saved-accounts.md
---

# Connect ChatGPT once for dedicated Codex Agents

- **ID:** TASK-0051
- **Status:** In review

1. Provision the reviewed Codex template and its public client. Separate device sign-in from the browser redirect used by other templates.
2. Complete device approval into a saved connection owned by the initiating user. Have the Token Service hold the single refresh grant for that account.
3. Let the user select that connection while configuring each Agent. Enforce the grant and the provider's account identity when preparing model and hosted catalog access.
4. Exercise enrollment, cross-user access control, two-Agent reuse and independent withdrawal through the supported workflows. Record which checks reached a real provider and Harness.

The PostgreSQL integration exercises device enrollment, separate grants for two Agents, delivery through the controller worker and withdrawal from one Agent. The browser test connects an account through Credentials and selects it for both Agents. These tests use a controlled external issuer. A live device approval and ChatGPT model turn still require an authorized account and a compatible Sandbox. [Current credential flow](../../docs/flows/connection-templates.md#sign-in-to-chatgpt-for-a-codex-harness).

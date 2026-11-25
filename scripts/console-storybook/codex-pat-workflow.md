# Verify Codex PAT Source selection

Build Storybook from the changed source using the
[Storybook instructions](../../docs/contributing/console-storybook.md).
The account, its issued PAT Source, and the API responses are simulated.

1. Open **Components/Credentials → ChatGPT service account**.
2. Choose **Issued ChatGPT service account** and select **Research service**.
3. Select **Save authentication source**. Confirm the saved authentication is
   a **Credential Source**. The Agent saves the returned Source ID and uses
   ordinary Source permissions.
4. Check **No issued service accounts** and **Issued service accounts
   unavailable**. An empty or refused list cannot supply a new selection.

Capture the account selection, saved Source, and refusal. The preview starts
after simulated issuance, so use the PostgreSQL issuance test for the actual
provider and custody boundary.

## Model Secret name recovery

Open **Pages/Create Agent → Password Secret conflict recovery**. At desktop and
phone widths, select **Choose existing Secret**, select a readable credential,
and confirm the Agent name and model remain. Reset the story, select
**Use another Secret name**, enter a new name, and submit. The Agent name remains
unchanged. This story simulates API responses; native browser tests verify the
controller's duplicate rejection, denied writes, and lost replies.

In **Secret conflict cleared for OAuth**, return to API key and confirm that the
old collision and alternate name stay cleared. In the conflict story, Tab from
the notice through the choices; Enter on the alternate choice focuses its input.
Repeat at phone width. Credential changes must not submit another Secret write.

In **Password Secret conflict recovery**, submit whitespace and an oversized
alternate name. The field must show validation without saving. Correct the name
and submit. For Service Accounts, choosing an existing Secret restores the normal
optional plugin discovery token disclosure when discovery requires credentials.

Change the Agent name after a collision. The old warning clears without a write.
When editing an alternate Secret name, name changes and later refusals preserve
that input; only feedback for the current attempted name can describe a collision.

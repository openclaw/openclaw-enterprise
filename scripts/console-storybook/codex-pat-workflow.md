# Verify managed and imported Codex PAT sources

Build Storybook from the changed source using the
[Storybook instructions](../../docs/contributing/console-storybook.md).
These previews use simulated accounts, Secrets, and API responses. They do not
prove account issuance, credential delivery, or native Codex login.

1. Open **Components/Credentials → ChatGPT service account**. Confirm
   **Issued ChatGPT service account** and **Research service** are selected.
2. Switch **Authentication source** to **Service Accounts**, choose the simulated
   imported token Secret, and save. Reopen the selector and confirm the imported
   source remains selected.
3. Switch back to **Issued ChatGPT service account**, select **Research service**,
   and save. Both choices use `codex_pat`: the imported choice references a Secret;
   the managed choice references the issued account. Managed selection must not
   create a Secret access grant.
4. Check **No issued service accounts**. Saving requires an account selection;
   another authentication method remains available.
5. Check **Issued service accounts unavailable**. The error explains the failed
   account lookup and preserves the saved selection.

Capture the managed, imported, empty, and denied states and a short recording
of switching and saving both sources. Keep captures outside the checkout and
label them simulated UI proof.

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

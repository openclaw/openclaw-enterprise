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

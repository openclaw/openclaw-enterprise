# Verify experimental Codex OAuth in the console

Build Storybook from the changed source using the
[Storybook instructions](../../docs/contributing/console-storybook.md).
Use dummy data only. These stories run the production console with simulated
authorization, plugin catalog, and deployment responses; they do not establish
provider login, credential-service persistence, refresh rotation, or runtime token injection.

## Create an Agent

1. Open **Pages/Create Agent → ChatGPT OAuth before sign-in (Experimental)**. Confirm the
   provider is OpenAI, the harness is Codex, and authentication is **ChatGPT OAuth (Experimental)**. Confirm the Experimental
   notice explains that sign-in, plugins, deployment, and recovery may have limitations.
   Confirm **Sign in with OAuth** is available. The model picker remains usable; no token input appears.
2. Open **ChatGPT device login pending (Experimental)**. Inspect the displayed code and the
   **Open Codex sign-in** link. Do not submit the simulated code to the provider.
   Choose **Cancel login** and confirm the sign-in button returns.
3. Open **ChatGPT login ready for plugin discovery (Experimental)**. Wait for the ready status,
   choose **Configure plugins**, select Calendar, and add it. Choose a model and
   create the Agent. Inspect the simulated requests: discovery carries a credential-source reference and Agent creation saves its source ID,
   never access or refresh tokens. Confirm creation opens the saved draft; deploy it
   separately from Agent detail because guided provisioning does not support credential sources.
4. Check **ChatGPT login permission denied (Experimental)**, **ChatGPT login exchange failed (Experimental)**,
   and **ChatGPT device login expired (Experimental)**. Failed or expired polls stop; recovery
   requires cancelling and starting a new login. Other form choices remain usable.
5. Open **ChatGPT login unavailable (Experimental)**. Confirm the message says sign-in
   is unavailable for this Installation and suggests another authentication method.
   No device code or provider link appears. Switch to API key and confirm the form
   remains usable.
6. Switch the harness to OpenClaw. ChatGPT OAuth disappears and API-key
   authentication is selected. Switching providers also clears the selected model
   credential. A staged login is discarded only through its explicit control.

## Edit an existing Agent

Open **Pages/Agent detail → Saved ChatGPT login for plugin editing (Experimental)**.
Browse plugins without signing in again, change a plugin policy, and save the selections.
The saved credential-source notice stays visible and the authentication source stays unchanged.

Open **Components/Credentials → Explicit ChatGPT credential replacement (Experimental)**.
Confirm the saved source is labeled **Credential source** and the ChatGPT replacement
sign-in notice shows the experimental status. The current source is preserved until a new login completes and the operator
chooses **Save authentication source**. Inspect the PATCH: `credentialSources`
replaces only the previous Harness entry and preserves unrelated source entries.
The old source resource remains available; deployment remains a separate action.
Clearing a new selection retains the current saved source. The newly created credential source also remains available for separate management.

Capture screenshots of pending, ready, and failure states and a short video of
sign-in, plugin selection, and cancellation. Keep evidence outside the checkout.
Record the tested commit and browser; label it simulated UI proof.

## Select a managed or imported PAT

Open **Components/Credentials → ChatGPT service account**. Confirm the issued
Research service account is selected. Switch to **Service Accounts**, select an
imported token Secret, then switch back to **Issued ChatGPT service account** and
save. The request uses `codex_pat` with a `service_account` source reference; the
imported choice uses the same method with a `secret` source reference. Check
**No issued service accounts** and **Issued service accounts unavailable** for
the empty and denied states.

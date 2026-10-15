# Verify experimental Codex OAuth in the console

Build Storybook from the changed source using the
[Storybook instructions](../../docs/contributing/console-storybook.md).
Use dummy data only. These stories run the production console with simulated
authorization, plugin catalog, and deployment responses; they do not establish
provider login, token persistence, refresh rotation, or runtime handoff.

## Create an Agent

1. Open **Pages/Create Agent → ChatGPT OAuth before sign-in (Experimental)**. Confirm the
   provider is OpenAI, the harness is Codex, and authentication is **ChatGPT OAuth (Experimental)**. Confirm the Experimental
   notice explains first-deploy, reconnect, revision, and recovery limitations.
   Confirm **Sign in with OAuth** is available. The model picker remains usable; no token input appears.
2. Open **ChatGPT device login pending (Experimental)**. Inspect the displayed code and the
   **Open Codex sign-in** link. Do not submit the simulated code to the provider.
   Choose **Cancel login** and confirm the sign-in button returns.
3. Open **ChatGPT login ready for plugin discovery (Experimental)**. Wait for the ready status,
   choose **Configure plugins**, select Calendar, and add it. Choose a model and
   create the Agent. Inspect the simulated requests: they carry a Secret reference,
   never access or refresh tokens.
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

## Inspect bootstrap failures

1. Open **Pages/Create Agent → Initial deployment pending**. Choose **Create
   Agent** and confirm the form remains pending, disables repeated creation,
   and keeps polling the original handle.
2. Open **Pages/Create Agent → Initial deployment failed**. Create the Agent,
   read the credential initialization failure, and open its existing Agent and
   revision. Confirm retrying creation is unavailable after admission.
3. Open **Pages/Agents → Latest deployment failed**. Compare the selected v6
   pointer with the recorded v7 failure, then open the failure link. Neither
   value asserts current serving health.
   Also inspect **Latest deployment access denied**, **Latest deployment loading**,
   and **Latest deployment unavailable**; each preserves the current pointer.
4. Open **Pages/Agent detail → Bootstrap failure with cleanup pending**.
   Read the retained Job/Pod and container evidence. Wait for cleanup to complete;
   the deployment must remain failed and the evidence must stay visible.
5. Open **Pages/Agent detail → Bootstrap container status and logs**. Confirm
   `prepare-oauth-home` exited 0 while `oauth-bootstrap` exited 1. Use **Pod /
   container** to select each stream and inspect its distinct simulated output.

Capture the pending and failed creation, list failure, cleanup, and container
states, plus a short video opening the failure and switching container streams.
These fixtures demonstrate UI behavior, not Kubernetes, persistence, provider
acceptance, or model execution. Keep captures outside the checkout.

## Edit an existing Agent

Open **Pages/Agent detail → Separate ChatGPT login for plugin editing (Experimental)**. Complete
the simulated login, change a plugin policy, and save the plugin selections.
The Experimental notice remains visible. The Agent's saved authentication source stays unchanged. **Discard staged login**
deletes only this configuration login.

Open **Components/Credentials → Explicit ChatGPT credential replacement (Experimental)**.
Confirm the authentication selector, saved summary, and sign-in notice show the
experimental status. The current source is preserved until a new login completes and the operator
chooses **Save authentication source**. Deployment remains a separate action.
Cancelling a new login retains the current saved source.

Capture screenshots of pending, ready, and failure states and a short video of
sign-in, plugin selection, and cancellation. Keep evidence outside the checkout.
Record the tested commit and browser; label it simulated UI proof.

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
   create the Agent. Inspect the simulated requests: discovery carries a credential-source reference and Agent creation includes that ID in both `harnessAuth` and `credentialSources`,
   never access or refresh tokens. Confirm creation opens the saved draft; deploy it
   separately from Agent detail because guided provisioning does not support credential sources.
4. Check **ChatGPT login permission denied (Experimental)**, **ChatGPT login exchange failed (Experimental)**,
   and **ChatGPT device login expired (Experimental)**. Failed or expired polls stop; recovery
   requires cancelling and starting a new login. Other form choices remain usable.
5. Open **ChatGPT login unavailable (Experimental)**. Confirm the message says sign-in
   is unavailable for this Installation, gives the API's reason (no Credential Refresh
   Driver) and suggests another authentication method. **Sign in with OAuth** stays
   unavailable: Tab reaches it, it is described by the message, and Enter sends no
   second start. No device code or provider link appears. Switch to API key and
   confirm the form remains usable.
   Open **ChatGPT login not offered by the Drivers (Experimental)**. Before any
   request, **Sign in with OAuth** is unavailable and described by the reason.
6. Open **Components/Credentials → ChatGPT sign-in answered on another tab
   (Experimental)**. Focus **Sign in with OAuth** and press Enter: focus stays on it
   while **Checking Codex login…** shows, then moves to **Cancel login**. Press Enter
   again: focus returns to **Sign in with OAuth**.
7. Open **Pages/Create Agent → ChatGPT sign-in start unconfirmed (Experimental)** and choose **Sign in
   with OAuth**. The preview interrupts the response. Confirm the Console explains
   that sign-in may have started and says to wait for an administrator to investigate
   the pending attempt. Switch to API key, then back to OAuth. Sign-in stays disabled,
   and the request log shows one start with no poll or cancellation.
8. Switch the harness to OpenClaw. ChatGPT OAuth disappears and API-key
   authentication is selected. Switching providers also clears the selected model
   credential. A staged login is discarded only through its explicit control.

## Return after an interrupted start

Open **Pages/Create Agent → ChatGPT sign-in interrupted by navigation (Experimental)**.
Choose **Sign in with OAuth**, then **Secrets** while the start is pending.
Use browser Back. Confirm that the Console asks an administrator to investigate
and disables another sign-in. Switch to API key and back: sign-in stays disabled.
The request log must show one start and no poll or cancellation.

Repeat with **Components/Credentials → ChatGPT replacement interrupted by navigation
(Experimental)**. The saved authentication stays unchanged. These stories simulate
an interrupted reply; the browser regression also checks a real OCC commit with
fixture Gateway and Refresh Drivers.

## Reply after a tab switch

Open **Components/Credentials → ChatGPT sign-in answered on another tab
(Experimental)**. Choose **Sign in with OAuth**, then the **Configuration** tab
within 3 seconds. Wait 3 seconds and return to **Credentials**. Confirm the code
and an enabled **Cancel login**. The request log must show one start.

Repeat with **ChatGPT sign-in refused on another tab (Experimental)**. On return,
the refusal names the missing grants and **Sign in with OAuth** is enabled.

Repeat the answered story, but before returning, choose **Edit Configuration**,
change the JSON and choose **Save Configuration**. The rebuilt **Credentials**
tab shows the same code.

Open **ChatGPT sign-in restarted on another tab (Experimental)**. Choose **Sign
in with OAuth**, then **Cancel login**, then **Sign in with OAuth** again and the
**Configuration** tab within 3 seconds. On return, the code shows. The request
log must show two starts and one cancellation.

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

# Browse unreadable saved configuration

These stories run the production Console against simulated read responses. They
do not prove PostgreSQL decoding, runtime health, or configuration repair.

1. Open **Pages / Agents / Unreadable saved configuration**. Both Agents remain
   listed. Research assistant has a **Saved configuration unreadable** badge.
2. Open **Pages / Agent detail / Unreadable Agent draft**. Confirm the Agent name
   and version history remain visible. Configuration, Plugins, Channels, and
   Credentials show the repair banner without editors or deployment controls.
3. Choose **v1 · Selected for service** in **Viewing version**. Its readable admitted settings
   remain available. Return to **Open draft** to see the draft error.
4. Open **Pages / Agent detail / Unreadable revision snapshot**. The selected
   version retains its identity and history entry. Configuration and Plugins
   show the repair banner; no missing settings appear as empty JSON or defaults.
   Deployment activity reports its own read failure.
5. Select **Open draft**. Its healthy draft can still be edited. Return
   to the unreadable version, switch tabs, and use **Retry** to confirm the
   scoped error stays visible. Check the same navigation at a narrow viewport.

Capture screenshots and a short walkthrough outside the checkout. Saved-state
decoding and strict deployment behavior are covered by the PostgreSQL/API tests.

## Repeated Configuration read denial

Open **Pages / Agent detail / Configuration read denied across reload and refocus**.
This story returns 403 for every draft Configuration GET. It is separate from
**Configuration unavailable** (503) and **Unreadable Agent draft** (invalid saved
settings).

1. Confirm **Research assistant** and **Configuration unavailable** appear
   together, with no draft editor. Leave this result visible for two seconds.
2. Reload the browser page containing the Storybook preview, not **Reset**.
   The same-origin tab storage preserves the refused path. Confirm the Agent
   remains visible. Reload can use the remembered refusal without a new draft GET.
3. Move focus to another browser tab, then click inside the Console preview.
   Refocus must issue a fresh Configuration GET returning 403. The Agent and
   scoped **Configuration unavailable** message remain visible. Leave the result
   visible for three seconds.
4. Select **Retry** to repeat the denied read. Confirm no editable defaults or
   page-wide **Access denied** replace the partial Agent.
5. Repeat at a 390 × 844 phone viewport. Capture the heading and scoped message,
   scrolling when needed. Keep the recording at normal speed.

The fixture implements fetch responses in the page, so these requests do not
appear as server traffic in the Network panel. For automated proof, observe the
fixture's fetch responses without replacing their behavior and record each
Configuration response status. This is simulated UI proof, not an IAM grant test.

## Binding preflight refusal and Save recovery

Open **Components / Credentials / Channel binding read denied**. This separate
story starts with readable bindings and stages **Slack backup token (simulated)**.

1. Note the staged app token, then select **Save channel Secrets**. The one-shot
   Configuration GET returns 403 before any PATCH. Confirm **Access denied** and
   the failed-preflight receipt, with no saved binding summaries or token pickers.
2. Refocusing alone must not restore stale bindings. Select **Refresh**. The next
   reads succeed and restore **Slack app token (simulated)**, the original saved
   binding. Refresh does not save the staged replacement.
3. Select **Slack backup token (simulated)** again and select **Save channel
   Secrets** once. Confirm the fresh preflight succeeds, one Configuration PATCH
   saves the replacement, and the success receipt names the saved bindings. Do not
   interpret a failed preflight as a completed save or replay the write automatically.
4. Record the staged value, scrubbed receipt, refreshed original, and explicitly
   saved replacement, pausing long enough to read each result. Repeat at phone
   width; keep captures outside the checkout.

In a real Console session, an Installation administrator must restore the exact
Configuration read grant before Refresh can recover. Native IAM browser tests
cover that authorization boundary. This story proves only UI recovery with
simulated responses; it does not prove persistence or Secret propagation.

## Save read revocation and prior-save receipts

Open **Pages / Agent detail / Authentication Save read denied**, then select
**Save authentication source**. Confirm the Agent name, authentication Secret link,
and editors disappear immediately. Keep the read-access reason and request ID in
view for three seconds. Refresh after the one-shot refusal restores saved state
without replaying Save.

In **Pages / Agent detail / Configuration Save read denied**, select **Save
Configuration**. Confirm the staged document disappears with the same causal
receipt. Refocus, then select **Retry** once reads recover. The discarded edit
must not return from another tab or browser history.

Open **Components / Credentials / Saved channel bindings, retry read denied**.
The prepared state has saved the replacement but failed its grant. Select **Retry
Secret access**. The receipt must retain the generic fact that bindings are saved,
identify the failed Configuration read, and expose no binding name or identifier.
Select **Refresh**, then explicitly retry the missing grant. There must be no
second Configuration PATCH and no duplicate successful grant.

Record desktop and phone walkthroughs at normal speed. Pause before each action
and on its visible result. These stories simulate API failures; Native IAM tests
separately verify authorization, zero writes, and history/draft retirement.

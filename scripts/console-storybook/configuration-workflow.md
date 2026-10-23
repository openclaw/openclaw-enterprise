# Driver configuration walkthrough

Rebuild Storybook before inspecting these stories. They render production console
components with simulated API state; they do not prove persistence or enforcement.

- **Pages/Settings → Account:** inspect the selected Installation Driver schema.
  No startup value or API mutation control is exposed.
- **Pages/Agent detail → Policy denials and reviewed network additions:** use
  **Add Network rules**, fill the schema fields, add a port range, then select
  **Review changes**. Preview does not change the saved version. Compare **Save**
  with **Save and apply to current revision**, then wait for provider confirmation.
- **Configuration preview field errors:** review a suggestion. The preview shows
  a field error and retains the proposal without saving.
- **Configuration version conflict retains draft:** preview a proposal and check
  the reload/review guidance and retained fields.
- **Another Driver renders enum fields from its schema:** add a rule and select
  a destination from the schema's enum. The owner controls remain the same.
- **A superseded preview preserves the newer draft:** start a preview, edit the
  rule before it returns, and confirm the old response does not open Save.
- **Overlapping policy refreshes retain the newest read:** click **Refresh policy**
  twice within 300 ms. The first response is older; wait for saved policy v3.
  Apply the saved policy and confirm polling reaches the simulated provider
  confirmation. The fixture simulates another operator's saves between reads;
  the browser integration performs actual HTTP saves.
- **Complex fields retain invalid JSON for correction:** review a suggestion,
  enter incomplete JSON for its destination, and confirm preview stays unavailable
  until the JSON is corrected. Expand **Schema** to inspect the field's constraints.
- **Configuration discovery loading/denied:** inspect the loading message and
  retry control. **Policy hidden while independent logs remain visible** keeps
  denial logs available while policy and suggestion reads show permission refusals
  without retry controls. **Sandbox policy capability unavailable** shows one
  unsupported message without fetching logs or recommendations.
- Inspect the existing empty, unsupported, loading, missing-credential, denied,
  and apply-rejected policy stories. After a saved change whose apply fails, the
  alert must identify the saved version.

Capture screenshots and an interaction video outside the checkout. Include the
story names and proof limits with the media; refresh it after material UI edits.

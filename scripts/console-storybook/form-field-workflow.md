# Check form fields

A form field is a label, its control, the control's error, then its help
(UX plan C3). Inputs and selects are 40 px tall with the strong edge; help is
13 px muted text 4 px under the control. The console checks required fields
itself: the browser's "Please fill out this field." bubble never shows. Check
each story at 1440 and at 390.

1. Open **Pages / Create Agent / Preset required fields**. Name, Model and
   Model Secret each show "… is required." in red under the control, above
   its help. Focus is on Name. Name, which names the Agent, is a single-line
   input; Model stays a textarea, as any other Preset string may hold several
   lines. The Preset template select has the same edge and height as the
   inputs.
2. Type a name. Its error clears; the others stay until Use Preset again,
   which moves focus to Model.
3. Open **Pages / Create Agent / Create Secret required fields**. The dialog's
   Value field shows "Value is required." and has focus.
4. Open **Pages / Agent detail / Share Agent required fields**. The Principal
   ID shows "Existing person’s Principal ID is required." and has focus; the
   acknowledgement shows "Check this box to continue." under it.
5. Open **Pages / Agent detail / Plugin selections JSON error**. The JSON
   shows "Enter a valid Plugin selections JSON object." under it and has
   focus; the status line below Save does not repeat it.
   Replace the draft with
   `{"sample":{"enabled":true,"driverPolicy":{"destructiveEnabled":1e400}}}`.
   Collapse the raw editor and select **Save plugin selections**. The editor
   opens, takes focus, and explains that the number is too large or too small
   to save. No Agent GET preflight or PATCH starts. Open **Configure plugins**.
   The alert explains the same number error. Focus stays in the dialog, and
   the raw text stays unchanged.
   Close **Configure plugins**. Paste `{"sample":{“enabled":false}}` into
   **Plugin selections JSON** and reopen **Configure plugins**. The alert
   identifies the curly quote by line and column and suggests a straight
   double quote. Choose **Done** or press Escape. Focus returns to
   **Configure plugins** and the draft stays intact.
   Tab to **Save plugin selections** and press Enter. The cursor should land
   just before the curly quote. Press Delete and type a straight double quote.
   The error clears. The rest of the draft stays intact.
   Replace the draft with `{"sample":{"enabled":"true"}}` and reopen
   **Configure plugins**. The JSON is valid, but the plugin expects a boolean.
   The alert should point to plugin enablement and tool policies.
   These are simulated UI checks. The browser test also checks a long draft
   against the real Controller.
6. Open **Authentication source required fields**. The API key Secret field
   shows "API key Secret is required." and has focus; its list stays closed,
   so nothing covers the error. Click the field or press ArrowDown to open
   the list. Choose another source: the error goes.
7. Open **Pages / Create Agent / Model credential Secret required**. The
   Service account token Secret field shows "Service account token Secret is
   required." with its list closed. Switch to API key: the error follows the
   label.
8. Open **Pages / Create Agent / Create Secret refused**. The "not ready"
   refusal shows in the dialog and has focus.
9. Open **Workspace file too large**. AGENTS.md shows the 16 KiB error, naming
   AGENTS.md, and has focus. Save again: the same error, no bubble. Reload
   AGENTS.md clears it.
10. Open **Pages / Create Agent / Create Secret fields the API would refuse**.
    Name shows "Remove tabs, line breaks and other control characters from the
    name." and has focus; Value shows "Use valid UTF-8 without NUL characters."
    Value is a masked multiline box: type two lines, then Show value, and
    both lines are there.
11. Open **Agent name the API would refuse**. Agent name shows the same Name
    rule and has focus. Open **Initial workspace file the API would refuse**:
    Advanced settings is open and AGENTS.md shows its 16 KiB error, naming the
    file, with focus.
12. With a screen reader, focus each field with an error: it reads the label,
    then the error and the help.
13. Open **Pages / Create Agent / Edit existing plugin policies**. Choose
    **Done**, enter an Agent name, select **Demo model API key (simulated)**
    as the **API key Secret**, and enter model `gpt-5.6-sol` using
    **Enter model ID manually** if needed. Keep Configuration valid. Replace
    **Plugin selections JSON** with `{"sample":{“enabled":false}}`, close
    the editor, then focus **Create Agent** and press Enter. The editor opens
    with the caret before the curly quote. The message gives its line and
    column and suggests a straight double quote. Press Shift+Right and type
    `"`. The error clears and the rest of the draft stays intact.

## Stored Preset refusal

Open **Pages / Create Agent / Preset with a non-text primary** at 1440 and 390 px.
The refusal explains that the primary model must be text and offers another
Preset or a template fix. The chooser stays open with **Marker** set to
`Retained chooser draft`. Follow the story steps to check navigation preserves
Marker, **Research assistant** opens a normal Agent form, and explicit selection
of **default-codex** gives the same refusal as the shortcut.

This preview uses the production form with a simulated GET for one older stored
Preset; the current Controller refuses to save that numeric primary. Keep
**Preset with an invalid field** as the separate execution-mode check.

## Browser chat at creation

Open **Pages / Create Agent / Browser chat opt-in**. The checkbox starts off.
Use Space to select it, clear it, then select it again. Create the Agent and
inspect the simulated provisioning request for `nativeAdmin: true`.
Open **Pages / Create Agent / Member browser chat setup** and repeat the choice.
The ordinary create request includes `nativeAdmin: true` and the saved
Configuration generation, without Installation administration.
**Browser chat selected** shows the checked state; **Browser chat unavailable**
shows the disabled control and installation setup guidance. In **Member with
Agent create**, the successful Namespace capability response gives the same
setup guidance, without a capability-retry instruction. Also inspect the
existing capability-loading, permission-denied, missing-credential, and create
failure stories. Capture the checkbox and its explanation at desktop and phone
widths. These fixtures prove UI behavior, not deployment or native authentication.

## Operator chat access

Open **Components / Native admin / Operator chat**. Confirm **Open chat** appears
and opens the simulated Agent page in another tab. Return and select **Refresh
access**. The card describes shared conversations. Compare **Available**, which
shows **Open Agent UI** and the administrative scope. Check the read-only,
unsupported, loading and failure stories: no usable launch link appears before
access succeeds. These previews use simulated responses; runtime authorization
and session revocation require the integration tests.

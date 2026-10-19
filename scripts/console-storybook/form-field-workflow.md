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
6. Open **Authentication source required fields**. The API key Secret field
   shows "API key Secret is required." and has focus. Press Escape to close
   its list and read the error. Choose another source: the error goes.
7. Open **Workspace file too large**. AGENTS.md shows the 16 KiB error and has
   focus. Save again: the same error, no bubble. Reload AGENTS.md clears it.
8. With a screen reader, focus each field with an error: it reads the label,
   then the error and the help.

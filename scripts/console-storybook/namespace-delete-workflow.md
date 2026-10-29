# Delete a Namespace

These previews use production Console components with simulated API responses.
They do not prove backend authorization, persistence, or infrastructure cleanup.

1. Open **Pages/Namespaces → Delete Namespace**. Select Engineering's trash
   icon. Check the name, ID, reserved-name warning, and default Preset disclosure.
   Cancel or press Escape; focus returns to the icon. Confirm another attempt:
   the row shows **Deleting…** until simulated status reads remove it.
2. Open **Delete confirmation mobile** at 390 × 844. The confirmation is a
   bottom sheet; both actions and the Namespace ID fit without horizontal scrolling.
3. In **Delete blocked by resources**, inspect resource counts and IDs. Two
   Configurations and the Secret are not listed: the simulated caller cannot
   read them, so the dialog counts them without IDs. Open Agents or Secrets in
   the same Namespace. Expand the Configuration commands. Closing the dialog
   does not delete resources.
4. In **Delete permission denied**, the icon looks disabled, with a visible
   reason: only an Installation administrator can delete a Namespace. Press Tab
   to focus the icon; its description reads the reason, its focus ring is not
   faded, and Enter opens nothing. In **Delete blocked by a Restriction**, an
   Installation administrator's reason names the Restriction instead.
   **Delete permission changed** shows a refusal after an advisory permission
   answer. **Delete request pending** holds dismissal until the write settles.
5. **Delete outcome unknown** requires **Refresh status** before another
   deletion request. **Delete cleanup recovery** keeps status and deliberate
   retry controls on an already deleting Namespace.

Capture desktop and phone screenshots and a short walkthrough outside the
checkout. Record the source revision and label these as simulated UI evidence.

# Slack plugin approvers

These stories use production Console controls with simulated Agent, Secret, and directory responses. They do not prove runtime approval enforcement.

1. Open **Pages / Create Agent / Plugin approvers need a Slack bot Secret**. The Agent default inherits OpenClaw's existing approval routing. The finder explains that a bot Secret must be selected under Channels before searching names.
2. Open **Pages / Agent detail / Plugin approver inheritance** and **Plugin and tool approver overrides**. Expand Calendar and Create event. Confirm the Agent default, plugin inheritance or empty override, and tool override are distinct. Change a mode, then inspect Plugin selections JSON before saving.
3. Open **Pages / Agent detail / Find Slack plugin approvers**. The open Alex search distinguishes people with the same display name by handle and user ID. Switch to another browser tab and return; the query and results stay open while access is checked. Move focus to another Console control to close the list, then focus the field to search again. Selecting a person saves a workspace-qualified selector. Entering a selector from another workspace after lookup shows an error. Check that the results dropdown remains usable near the bottom of a scrollable plugin or tool editor.
4. Open **Pages / Agent detail / Plugin approvers accept raw Slack IDs**. The simulated API returns 501 for channel directory lookup. Confirm the picker explains that exact IDs remain available, add `UDEMO123`, and save plugin selections. The saved draft keeps the raw Slack user ID even though names cannot be resolved.

See [Slack directory](slack-directory-workflow.md) for channel and user name lookup stories.

# Agent workspace files

Use the console to set initial `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and
`USER.md` contents when creating an Agent, then edit them in its live workspace
after deployment. These files are separate from the Configuration draft and
AgentRevision.

## Set files when creating an Agent

1. Open **Agents** in the intended Namespace and start creating an Agent.
2. Open **Advanced settings**. In **Workspace files**, review the prefilled
   OpenClaw defaults and edit the files you want to customize. Leaving the text
   unchanged submits that default; clearing a field submits an empty file. Each
   field accepts up to 16 KiB of UTF-8 text. The browser uses LF newlines.
3. Select **Create Agent**. Where the installation supports Dedicated
   provisioning, a Dedicated Agent starts provisioning and its first
   deployment. Otherwise, including every Embedded Agent, creation saves an
   undeployed draft; deploy it with **Deploy new version** on its Agent page.
   Creation saves the inputs privately, and the first deployment applies them
   before execution starts.
4. Once the revision is active, open **Workspace files** on the Agent and reload
   the files to check the contents.

If creation says that defaults changed, reload the form and review the defaults
again. If deployment cannot initialize the workspace, have an operator check
runtime compatibility and durable storage before retrying. Setup refuses to
overwrite conflicting edits during an incomplete attempt. After completion,
restarting or redeploying preserves subsequent workspace edits.

You cannot edit staged inputs on an undeployed Agent. To correct them, delete
the Agent (**Delete Agent** on its page, or the API; both need Agent `delete`)
and create it again. The [initial contents reference](../../reference/agents.md#initial-contents-at-creation)
defines API omission, empty values, and the pinned defaults contract.

## Edit a file

You need `read` on the Agent to load files and `operate` to save them. The Agent
must have an active revision and a reachable gateway. Platform workspace access
is documented for [Kubernetes](../deploy/workspace-routing.md#agent-workspace-files);
it is not available with the bundled [SSH Driver](../../reference/drivers/ssh-compute.md#credentials-and-supported-boundaries).

1. Open **Agents**, select the Agent in the intended Namespace, and open
   **Workspace files**.
2. The four files are listed with their own **Reload** and **Save**. Use
   **Reload** before editing if another person might have changed the file;
   reloading discards your unsaved changes.
3. Edit the text, then select **Save** for that file. Saving creates or replaces
   only the selected file. Each file can contain up to 16 KiB of UTF-8 text.
4. Reload the file to confirm the expected content was stored.

There is no version check: if two people edit a file, the last write wins. Do
not put credentials in these files. Use a [Secret](../../reference/configuration/secrets.md)
for credential values.

## If files cannot be loaded or saved

- **Immediately after deployment:** the gateway may still be starting. Confirm
  the expected [revision](agent-revisions.md) became active, then reload. If
  access stays unavailable, have an operator check
  [workspace routing](../deploy/workspace-routing.md#agent-workspace-files).
- **A save has an unknown outcome:** it may have succeeded. Reload the affected
  file and compare its content with your edit before saving again. A failure
  for one file does not establish what happened to the others.
- **The request is rejected:** check that the file is one of the four supported
  names, your text fits the limit, and you have Agent `operate` permission.

For automation, the [workspace file API](../../reference/agents.md#workspace-files)
documents the paths, limits, and errors.

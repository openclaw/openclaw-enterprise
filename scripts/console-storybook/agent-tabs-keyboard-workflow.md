# Walk the Agent tabs with the keyboard

Agent sections and revision views use separate tab lists. Each has one Tab stop;
arrow keys move focus, and Enter or Space opens the focused tab. Use the keyboard.

1. Rebuild Storybook, then open **Pages / Agent detail / Historical revision
   workspace** at desktop width. The selected revision row connects to
   **Revision v6**, marked historical and read-only. The Agent sections list
   contains Revisions, Workspace files, and Access; the separate revision list
   contains Configuration, Plugins, Channels, Deployment, Logs, and Policy denials.
2. Tab to the revision tabs. Focus lands on **Configuration**. Press Right,
   Right, Left, End, and Home. Focus moves and wraps without changing the panel
   or the address. Press Right, then Enter: **Plugins** opens.
3. Choose another saved revision with the keyboard. Plugins stays selected.
   Open Logs, then choose Draft: Configuration opens because Draft has no Logs.
   Confirm **Build next revision** and Draft context appear above the tabs, with
   the deployment checklist below them. Repositories and Credentials are draft tabs.
4. Reach the Agent sections list. End, then Enter opens **Access** with
   `tab=access`. The revision picker and revision tabs disappear. Home, then
   Enter returns to **Revisions**, with Configuration selected. Open
   **Workspace files** from the Agent sections list: `tab=workspace` remains the
   URL, and the page explains the serving runtime rather than the viewed snapshot.
5. Use Back and Forward through these destinations. The selected section and
   tab follow the address. Within either tab list, press End, then Tab and
   Shift+Tab: focus returns to its selected tab, not the last arrow-key target.
6. Open **Long version history**. Check the desktop rail scrolls without pushing
   the detail panel below it. Load older versions while browsing and keep the
   viewed revision. Above 520 px, scroll the detail panel: its heading and tabs
   remain visible. On a phone, they stay connected and scroll with the content.
   Expand Revision details to inspect identifiers, then collapse it.
7. Narrow the preview to 1,100 px or less, then phone width. **Viewing version**
   replaces the rail above the revision heading. Use its native keyboard controls
   to select a revision. Revision tabs scroll sideways; the faded edge marks
   more tabs. End brings the focused tab into view. Workspace files and Access
   still show no revision selector.

Repeat the hierarchy check in **Unreadable Agent draft**, **Unreadable revision
snapshot**, **Deployment activity loading**, **Version draft, viewer can only read**, and **New version
missing credentials**. Keep the relevant read error, disabled reason, or credential
recovery visible below the correct context. Pending saves still block navigation;
use **Sharing holds navigation** to inspect the pending grant message and recovery.

These stories use simulated API and runtime state. Record the tested revision,
viewport, screenshots, and interaction video separately; this walkthrough does
not prove backend persistence, credential delivery, or live runtime behavior.

# Check the dialog pattern

Every modal dialog shares one chrome: `--radius-lg` corners, the `--color-border`
edge, `--shadow-2` and one gray backdrop. It opens with a short
`--duration-base` fade and slide. Plugins use the wide variant, channel editors
the drawer, and at 760 px and below every dialog is a bottom sheet. Stories use
simulated data.

1. Open **Components / Dialogs / Stop confirmation**, **Delete confirmation**
   and **Create Secret**. Each is a centred box with the same corners, edge,
   shadow and backdrop. Cancel is on the left and the confirming action on the
   right. Focus starts inside the dialog (Cancel for Stop and Delete, Name for
   Create Secret).
   In Delete, read what stays in the Namespace, then open **View separate cleanup
   commands**. Each command includes the Namespace ID. Copying it keeps the
   confirmation open and runs nothing.
   In **Backdrop at the desktop scrollbar**, choose **Open preview in its own tab**
   to check the window’s scrollbar gutter, rather than the surrounding frame.
   An empty gutter blends into the backdrop; a classic scrollbar remains visible.
   Press Escape: the page keeps its position and original colours.
2. Open **Plugins (wide)**. The same chrome holds the plugin workspace, 72 rem
   wide. Wider than 1100 px the catalog and the selected plugin's detail sit
   side by side.
   Open **Plugins (tablet)** (a 1024 px frame). Up to 1100 px the workspace
   stacks: the catalog shows alone, choosing Calendar replaces it with
   Calendar's detail, and **Back to plugins** returns to the catalog.
3. Open **Slack editor (drawer)**. The drawer floats 16 px from the right, top
   and bottom edges with the same corners, and slides in from the right.
4. Press Escape in each dialog. It closes and focus returns to the button that
   opened it (Stop Agent, Delete Agent, Configure plugins, Edit Slack, or the
   Secret field). Escape and backdrop clicks behave as before: Stop and Delete
   ignore the backdrop, and a pending save keeps a dialog open.
5. Open each **(phone)** story. The dialog is a full-width sheet on the bottom
   edge with rounded top corners. Stop, Delete and Create Secret are only as tall
   as their content. The drawer header keeps Close beside its title.
6. Turn on reduced motion (browser developer tools, Rendering, "Emulate CSS media
   feature prefers-reduced-motion: reduce") and reopen a dialog: it appears
   without the fade or slide.
7. On a phone, open the **Create Secret (phone)** fixture in its own tab, not
   inside Storybook, because an iframe's visible area does not follow the
   page's keyboard: `/storybook-fixtures/frame.html?story=slackCreateSecretModal`.
   Tap Name. The sheet rises with the on-screen keyboard, so Cancel and Create
   Secret stay above it. A desktop browser has no on-screen keyboard; pinch
   zoom shrinks the visible area the same way, and the sheet follows it.

## Create a Secret with a long Agent name

Open **Components / Dialogs / Create Secret**, then repeat in **Create Secret
(phone)**. Both use the same simulated scenario.

1. Inspect the initial Name before typing. The long Agent name is shortened with
   an ellipsis; the Name ends with **Slack bot token** and fits the 200-character
   limit. Scroll within the input to inspect its end.
2. Replace Name with **Walkthrough Slack bot token**. Enter
   `synthetic-demo-token` as Value, then select **Create Secret**.
3. Confirm the modal closes and **Walkthrough Slack bot token** is selected in
   the Slack editor. Creation returns Secret metadata from the simulated service
   with status 201. The selection remains staged until the editor is saved.
4. For cancellation, open **Pages / Create Agent / Create Slack Secret before
   Agent exists**. Enter a synthetic value and click the backdrop. The Secret
   modal closes while the Slack editor stays open. Reopen Create new Secret and
   confirm Value is empty. Press Escape, then cancel the editor.

Capture the initial Name, the edited form and the selected Secret on desktop and
phone, plus a short recording of editing and creation. Use synthetic values only.
These fixtures do not verify backend persistence or delivery to Slack.

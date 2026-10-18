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
2. Open **Plugins (wide)**. The same chrome holds the plugin workspace, 72 rem
   wide.
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

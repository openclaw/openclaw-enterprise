# Check focus rings and disabled controls

Every control shows the same focus ring: `--focus-ring` at `--focus-offset`.
Rows and panes that sit against an edge use the inset offset, and wrappers
draw the ring for a borderless child. Use the keyboard, not the mouse: the ring
follows `:focus-visible`.

1. Open **Pages / Agents / Populated**. Tab from the navigation to the Agent
   links. Every stop, including the Namespace select, Refresh, search, Create
   Agent and each Agent name, shows the same 3 px accent ring just outside its
   edge.
2. Open **Pages / Agent detail / Draft**. Tab to the selected tab, arrow through
   the others, then Tab to Edit Configuration and the **View native
   Configuration** disclosure. Each one shows the same ring.
3. Open **Pages / Agent detail / Runtime logs**. Tab to the log pane. Its ring
   sits inside the pane edge (inset). Tab to a log row summary. Its ring sits
   outside, like a button.
4. Open **Pages / Create Agent / Repositories using the Agent default**. Tab to
   a repository row. The row draws an inset ring around its checkbox.
5. Open **Components / Channels / Slack directory channels**. Tab into the
   directory search. The bordered wrapper draws the ring, not the inner input.
   Arrow through results: the active result has an inset ring.
6. Open **Pages / Namespaces / Ready and provisioning**. Tab to a Namespace
   name. The whole row card draws the ring.
7. Open **Pages / Create Agent / Default Preset Loading** (**Use Preset** is
   disabled) or **Pages / Agents / Create Restricted** (**Create Agent** is
   disabled). Hover the button: the pointer is `not-allowed` and the button is
   at 0.6 opacity. A button with `aria-busy="true"`, or a disabled
   button inside an `aria-busy="true"` region, shows the `progress` pointer.
   Pending action buttons (Stopping…, Deleting…, Save) do not set `aria-busy`
   yet, so they also show `not-allowed` while pending (finding 1927).

Check steps 1 and 3 again at a narrow viewport.

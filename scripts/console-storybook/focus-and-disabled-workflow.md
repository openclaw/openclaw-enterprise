# Check focus rings and disabled controls

Every control shows the same focus ring: `--focus-ring` at `--focus-offset`.
Rows and panes that sit against an edge use the inset offset, and so do items
inside a scrolling list or tab strip, which would clip an outer ring. Wrappers
draw the ring for a borderless child. Use the keyboard, not the mouse: the ring
follows `:focus-visible`. No part of any ring may be cut off.

1. Open **Pages / Agents / Populated**. Tab from the navigation to the Agent
   links. Every stop, including the Namespace select, Refresh, search, Create
   Agent and each Agent name, shows the same 3 px accent ring just outside its
   edge.
2. Open **Pages / Agent detail / Draft**. Tab to the selected tab, arrow through
   the others, then Tab to Edit Configuration and the **View native
   Configuration** disclosure. Each tab shows the inset ring on all four sides;
   the other stops show the outer ring.
3. Open **Pages / Agent detail / Long version history**. Tab to a version in
   the version list. It shows the inset ring on all four sides.
4. Open **Pages / Agent detail / Runtime logs**. Tab to the log pane. Its ring
   sits inside the pane edge (inset). Tab to a log row summary. Its ring sits
   outside, like a button, and the pane scrolls far enough to show its bottom
   edge.
5. Open **Components / Dialogs / Plugins (wide)**. Tab through the search field,
   Load plugins and the plugin list. The search field and buttons show the
   outer ring; each plugin in the list shows the inset ring.
6. Open **Pages / Create Agent / Repositories using the Agent default**. Tab to
   a repository row. The row draws an inset ring around its checkbox.
7. Open **Components / Channels / Slack directory channels**. Tab into the
   directory search. The bordered wrapper draws the ring, not the inner input.
   Arrow through results: the active result has an inset ring.
8. Open **Pages / Namespaces / Ready and provisioning**. Tab to a Namespace
   name. The whole row card draws the ring.
9. Open **Pages / Create Agent / Default Preset Loading** (**Use Preset** is
   disabled) or **Pages / Agents / Create Restricted** (**Create Agent** is
   disabled). Hover the button: the pointer is `not-allowed` and the button is
   at 0.6 opacity. A button with `aria-busy="true"`, or a disabled
   button inside an `aria-busy="true"` region, shows the `progress` pointer.
10. Open **Components / Stop Agent / Stop pending**. Stopping… sets
    `aria-busy="true"` and shows the `progress` pointer, as Deleting… and a
    saving Save Configuration do (finding 1927).
11. On **Pages / Agent detail / Draft** and **New version failed, deploy
    again**, only one button is filled with the accent. Secondary buttons have
    a dark edge, and Refresh buttons have none.

12. Links are ink, not accent; the accent marks actions, the current nav item,
    selection and the selected tab. On **Pages / Agents / Latest Deployment
    Failed**, each Agent name is dark text with no underline until you hover or
    Tab to it. The revision ID and the **v7 · failed** deployment link stay
    underlined. On **Pages / Namespaces / Ready and provisioning**, hovering
    anywhere on a row underlines its name.
13. On **Pages / Agent detail / Deployment Failed**, the credential link in the
    Configuration snapshot is dark text with a grey underline that darkens on
    hover. **View admitted native configuration** is dark and underlined, not
    accent, and still opens the JSON. In **Components / Dialogs / Plugins
    (wide)**, **Access and credential setup** looks the same.

Check steps 1 to 5 again at a narrow viewport (390 px; use **Plugins (phone)**
for step 5).

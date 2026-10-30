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
3. Open **Pages / Agent detail / Long version history**. Tab to **Viewing
   version**. The native picker is one Tab stop and names v8 as the viewed version.
   Use its native keyboard controls to choose a version. Tab to **Load older
   versions** and press Enter: while the next page loads it reads **Loading older
   versions…**, looks disabled, and keeps focus. When the last page loads, focus
   returns to the picker and the viewed version stays selected. On **New version
   in progress, then current**, focus the picker before the poll finishes: its
   service marker updates without moving focus or changing the viewed version.
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
9. Open **Pages / Create Agent / Capability check failure** (**Create Agent**
   is disabled). Hover the button: the pointer is `not-allowed` and the button
   is at 0.6 opacity. A button with `aria-busy="true"`, or a disabled
   button inside an `aria-busy="true"` region, shows the `progress` pointer.
   An unavailable control whose reason shows beside it stays in the Tab order
   instead (`aria-disabled`): open **Pages / Create Agent / Choose a starting
   point** and Tab to **Use Preset**. It takes focus, its description is the
   status line, and Enter or Space does nothing. Its label, fill and edge fade,
   not the whole button, so its focus ring keeps full contrast. **Deploy new
   version**, **Save plugin selections**, **Discard changes**, **Save channel
   Secrets**, **Strict mode** and the Gateway toggles do the same (finding
   2878); an unavailable checkbox's label draws its ring. So do the list's
   **Create Agent**, Stop and Delete icons, **Create Secret**, **Run
   diagnostics**, the Logs controls, the plugin dialog's **Load plugins** and
   pager, and the read-only authentication and Slack token fields (finding
   2899): a select or text field fades its text, and ignores arrow keys and
   typing too. So do the Secret dialog's **Replace value** and **Delete
   Secret** (**Pages / Secrets / Read only for this caller**) and the issued
   account select (**Components / Credentials / Issued service accounts
   unavailable**) (finding 2925). On **Pages / Agents / Stop from the list**,
   confirm Stop: the Stop icon becomes unavailable and keeps focus, described
   by its Stop requested badge (finding 2926). So do a refused **Create
   Namespace** (**Pages / Namespaces / Create refused, then closed**), **Create
   Agent** waiting for a Namespace (**Pages / Create Agent / Form, Namespace
   still provisioning**), **Disable Slack** (**Components / Channels / Slack
   Disable, editor must replace the bot token Secret**), Configure Slack on an
   Embedded Agent, the Share Agent form after a failed change (**Pages / Agent
   detail / Sharing outcome uncertain**) and the Logs controls of a version
   with no running Pod (**Pages / Agent detail / Logs of a version with no
   running Pod**). A dialog that cannot submit after a refusal or an unknown
   outcome keeps its fields and confirmation in the Tab order, described by
   its alert, while focus moves to Cancel or Close (finding 2935): **Pages /
   Namespaces / Create permission denied** and **Create outcome unknown**,
   **Pages / Secrets / Create denied** and **Concurrent reference conflict**,
   and the Stop and Delete confirmations when a refusal arrives while they are
   open (**Pages / Agents / Stop from the list, permission arrives while
   confirmation is open**, **Components / Stop Agent / Permission arrives while
   confirmation is open**, **Components / Deletion / Permission arrives while
   confirmation is open**). Delete Agent after an unknown outcome
   (**Components / Deletion / Outcome unknown**) or a refusal (**Components /
   Deletion / Permission denied**, finding 2951) is described by its alert, as
   is a refused Stop Agent (**Components / Stop Agent / Permission denied**)
   and a refused list row icon, whose row note names the grant (**Pages /
   Agents / Stop from the list denied**, finding 2955). So are the header's
   Namespace selector with no readable Namespace (**Pages / Agents / No
   readable Namespaces**, finding 2936) and **Start with default
   Preset** without a default Preset (**Pages / Create Agent / No Presets**,
   finding 2937), whose hint says why. With other Presets (**Pages / Create
   Agent / Other Presets, no default**), the chooser's status says only
   "Choose a Preset." and describes Use Preset; the hint is not repeated
   (finding 2946). A list row refused for a reason other than grants shows the
   API's text in its alert, its note names no grant but reads "Not deleted:
   see above", and its icons stay reachable, described by the alert, until
   Refresh (**Pages / Agents / Delete from the list refused for another
   reason**, findings 2958, D812). On **Pages / Agents / Refocus after
   another person's stop**, focus Stop, switch windows and return: the
   rebuilt row has no Stop, and focus is on the Agent's name (finding 2967).
   So do Previous instance before a restart (**Pages / Agent
   detail / Runtime status after a healthy first deploy**), described by its
   note (finding 2944), and Execution mode with the Codex harness (**Pages /
   Create Agent / OpenAI with Codex harness**, Runtime details open), described
   by its hint (finding 2945).
10. Open **Components / Stop Agent / Stop pending**. Stopping… sets
    `aria-busy="true"` and shows the `progress` pointer, as Deleting… and a
    saving Save Configuration do (finding 1927).
11. On **Pages / Agent detail / Draft** and **New version failed, deploy
    again**, only one button is filled with the accent. Secondary buttons have
    a dark edge, and Refresh buttons have none.
12. Open **Pages / Agent detail / Header actions**. Focus **Open draft**, switch to another window, and return. The action stays visible
    but inactive during the access check, then regains focus. Repeat while
    moving focus to the sidebar during the check; focus stays where you moved it.

13. Links are ink, not accent; the accent marks actions, the current nav item,
    selection and the selected tab. On **Pages / Agents / Latest Deployment
    Failed**, each Agent name is dark text with no underline until you hover or
    Tab to it. The **v6** current version link and the **v7 · Failed**
    deployment link stay underlined. On **Pages / Namespaces / Ready and provisioning**, hovering
    anywhere on a row underlines its name.
14. On **Pages / Agent detail / Deployment Failed**, the credential link in the
    Configuration snapshot is dark text with a grey underline that darkens on
    hover. **View admitted native configuration** is dark and underlined, not
    accent, and still opens the JSON. In **Components / Dialogs / Plugins
    (wide)**, **Access and credential setup** looks the same.
15. Open **Components / Native admin / Refreshing access**. Tab to **Refresh
    access** and press Enter: while it reads (1.5 s) it keeps focus. Repeat and
    press Tab during the read: focus stays where you moved it. On **Available
    once a deployment completes**, focus the unavailable **Open Agent UI**
    before the poll lands: the live link that replaces it keeps focus.

16. Open **Components / Credentials / Scrolling Secret list**. Click **API key
    Secret**: the list scrolls. Press Tab: the list closes and focus moves to
    the metadata link, not the page. The list is never a Tab stop; Up and Down
    move through its options from the field (finding 1919).
17. Open **Pages / Create Agent / OpenAI with Codex harness** at 1280 x 800.
    The form is taller than the window. **Cancel**, **Start over** and
    **Create Agent** stay in a row at the foot of the window while you scroll,
    and **Create Agent** is the only filled button. At the end of the page the
    row settles below Channels (finding 2098).

Check steps 1 to 5 again at a narrow viewport (390 px; use **Plugins (phone)**
for step 5).

## Agent collection access checks

Open **Pages / Agents / Populated Namespace leaves the list** at desktop and
phone widths. Keep focus in Search Agents while the idle Namespace read finishes.
The warning names the lost access, all Agent rows disappear, and Create Agent is
disabled. Clear the search: the rows must not return. The existing empty
**Namespace leaves the list while provisioning** story covers the same warning
without rows. These stories simulate API responses; browser tests exercise the
controller and IAM decisions.

Repeat with **Namespace loss with Stop dialog** and **Namespace loss with Delete
dialog**. The background check closes the confirmation and focuses Search Agents.
Previous row feedback disappears. No empty-list message appears beside the
unavailable warning. Submitted requests report generic acceptance, refusal or
unknown outcomes without Agent details or replay. Browser tests also cover session
expiry. Use the late Stop response story to inspect its generic result.

# Check the page header

The page header (UX spec 3.2) has two shapes. Collections (Agents, Backends) show
the title and its scope line at the left. At the right are the compact Namespace
control and Refresh: one 32 px box with "Namespace" as a muted prefix inside.
An Agent's page and Create Agent lead with **← Agents**. Next comes the title,
with the actions at its right above 1100 px. At 1100 px and below, the actions
share the back-link row and the title has its own row. Under the title is a meta
row: the Agent ID, **Copy Agent ID** and the compact Namespace control. Settings and Namespaces show no
Namespace control. Check each story at 1440, 1101, 1100, 1024 and 390 px.

1. Open **Pages / Agents / Populated**. The Namespace control is 32 px tall, with
   its label inside the box, and shares a line with Refresh.
2. Open **Pages / Agent detail / Page header with a long name**. At 1100 and 1024 px,
   Refresh and Open draft share the back-link row above the name. At 1101 px,
   they move beside the name. Nothing overlaps at either side of the breakpoint.
   At 390 px, select **Copy Agent ID**. Check that “Copied” is readable and
   Namespace stays in place. At 920 px, Tab to **Copy Agent ID**, move the pointer
   over **Namespace**, and press Enter to copy the same ID. When “Copied” appears,
   click without moving the pointer. The Namespace menu should open. Press Escape
   and check that the selected Namespace is unchanged. Repeat this pointer check
   in step 6 when “Copy selection” appears instead.
   In the Controller-backed Console, also hold the button on one Agent, go Back
   to a different Agent, and release over its copy button. No copy should occur
   until you press that Agent’s button yourself.
3. In the same story, select **Open draft**. The draft's header shows
   Refresh only. Select **Edit Configuration**, change a value, and select
   **← Agents**. The page stays and says why.
4. Open **Pages / Agent detail / First version** at desktop and phone widths. Tab to
   **Namespace**, then Tab once more. Scroll down with the mouse wheel and press
   Shift+Tab to return to Namespace. The whole focus outline, including its top
   edge, must be visible. Repeat on a signed-in draft Agent’s Configuration page
   to check the real Console.
5. Open **Pages / Agent detail / Page header at 390px**. The header is four
   rows: ← Agents with the actions, the name, the ID row, then the Namespace
   control at full width. It ends by 240 px. Switch to another window and back.
   While the access check runs, Open draft is held with the page, and
   focus returns to it.
6. Open **Pages / Agent detail / Copy Agent ID without clipboard access**. The
   entire Agent ID is selected and "Copy selection" appears.
7. Open **Pages / Create Agent / Choose a starting point** and **Pages / Settings / Account**.
   Create Agent has ← Agents and the Namespace control under its title. Its
   card heading, **Your next teammate**, is a step smaller than the page title
   (18 px against 24 px). Settings has no Namespace control.

Storybook fixtures are simulated UI proof. They do not verify a live
deployment or clipboard permissions in a real browser profile.

## Compare collection rows

1. Open **Pages / Agents / Latest deployment failed** at 1440 px. Read the Agent name, full ID, current version, and failed deployment. Tab to the deployment link and press Enter. Return to the list and check the focused link and its row.
2. Open **Latest deployment failed on mobile**. Execution mode and current version share a line. The failure and row actions have the full width. Open navigation and check the selected page and each link label.
3. Open **Pages / Credentials / OAuth connection templates**, **Pages / Credentials / Secrets / Populated**, and **Pages / Namespaces / Ready and provisioning**. Tab through the rows. Check the shared heading colors and the focus indicator for each action.

## Return to Agents while the list refreshes

1. Open **Pages / Agents / Row navigation** in its own tab. Open an Agent and return with **← Agents** or browser Back. Without moving focus during the return, check that focus returns to the Agent name and its row is visible.
2. Sign in to a development Controller with enough Agents to scroll. Filter the Agents list, use the arrow keys to reach a row below the fold, and press Enter. Enable a browser network throttling profile with 1,500 ms latency for the return.
3. From the top of the Agent page, press browser Back. Leave the keyboard and pointer alone until the list returns. The inert detail must stay in place. When **Still checking…** appears, it must be visible without shifting the heading or reading position. The list must restore the filter and show the focused Agent row. Repeat after scrolling the detail to Configuration, at desktop and phone widths.
4. Repeat the slow return and press Tab until **Namespace** has focus while the list read is pending. Let the unchanged list load. Namespace must remain focused and visible, and the next Tab must continue from it. Repeat with browser Back and **← Agents** at desktop and phone widths.
5. In **Pages / Agent detail / Page header with a long name**, use the keyboard to switch from Engineering to Research. Check that the Research Agents list opens.
6. On a signed-in Controller, open an Agent from the West list. Switch to East and open an Agent there. Slow the West list read and switch back to West. The Agents heading takes focus immediately. East’s name, ID and copy button disappear. If the read takes long enough, **Loading…** appears. When the list returns, the West row should be focused and visible. Repeat and Tab to **Namespace** while waiting. On a phone, try Shift+Tab to **Open navigation** instead. Focus should stay where you moved it.
7. On the signed-in Controller, repeat the West-to-East route. Slow the session check. In the browser’s Back history menu, choose the West Agent, skipping the East list. While the check is pending, switch to another browser tab and return. When the West Agent appears, its heading should have focus, and the first Tab should reach **Refresh**. Repeat and move focus to the **Agents** link in the sidebar while waiting. Focus should stay on that link. At 390 × 844, repeat and press Shift+Tab to focus the closed **Open navigation** button after returning to the browser tab, while the West Agent is still loading. When loading finishes, focus should stay on **Open navigation**, and the next Tab should reach the account button.

The stock Row navigation story has two rows and no built-in return delay. To check the slow return in the standalone story, supply extra rows and a delayed successful reply.

The signed-in browser tests hold successful responses automatically. Install the Console browser test prerequisites before running them.

```sh
node --test --test-name-pattern="Back keeps the keyboard-focused Agent in view when the filtered list changes" tests/browser/console-refocus-focus.test.ts
node --test --test-name-pattern="Switching Namespace|Back across Namespaces" tests/browser/console-retained-revalidation.test.ts
```

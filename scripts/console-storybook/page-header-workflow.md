# Check the page header

The page header (UX spec 3.2) has two shapes. Collections (Agents, Backends) show
the title and its scope line at the left. At the right are the compact Namespace
control and Refresh: one 32 px box with "Namespace" as a muted prefix inside.
An Agent's page and Create Agent lead with **← Agents**. Next comes the title,
with the actions at its right. Under it is a meta row: the Agent ID, **Copy
Agent ID** and the compact Namespace control. Settings and Namespaces show no
Namespace control. Check each story at 1440, 1024 and 390.

1. Open **Pages / Agents / Populated**. The Namespace control is 32 px tall, with
   its label inside the box, and shares a line with Refresh.
2. Open **Pages / Agent detail / Page header with a long name**. At 1024 the
   name wraps to two lines on the left. Refresh and Open draft stays at
   its right, and nothing overlaps. Select **Copy Agent ID**: "Copied" shows
   beside it.
3. In the same story, select **Open draft**. The draft's header shows
   Refresh only. Select **Edit Configuration**, change a value, and select
   **← Agents**. The page stays and says why.
4. Open **Pages / Agent detail / Page header at 390px**. The header is four
   rows: ← Agents with the actions, the name, the ID row, then the Namespace
   control at full width. It ends by 240 px. Switch to another window and back.
   While the access check runs, Open draft is held with the page, and
   focus returns to it.
5. Open **Pages / Agent detail / Copy Agent ID without clipboard access**. The
   ID is selected and no "Copied" status shows.
6. Open **Pages / Create Agent / Choose a starting point** and **Pages / Settings / Account**.
   Create Agent has ← Agents and the Namespace control under its title. Its
   card heading, **Your next teammate**, is a step smaller than the page title
   (18 px against 24 px). Settings has no Namespace control.

Storybook fixtures are simulated UI proof. They do not verify a live
deployment or clipboard permissions in a real browser profile.

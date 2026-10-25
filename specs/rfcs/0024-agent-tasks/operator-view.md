---
rfc: index.md
---

# Agent Tasks: operator view

This companion to [RFC-0024](index.md) describes the proposed console pages. The reader is a person who guides
several Agents and has a few minutes between other work. Each page must answer three questions in this order:
**what needs me, what is happening, what changed since I last looked.** Nothing here is implemented.

## Tasks page

A new **Tasks** entry in the console navigation opens `/console/tasks` for the selected Namespace. The page has three
regions.

1. **Needs you.** Tasks in `needs_person` or `review` that the viewer can update, oldest first. Each row shows the
   reason in words ("asks: which branch should the fix target?", "stalled for 42 min", "delivery uncertain",
   "report ready"), the Agent, the age and one primary action: reply, choose, redeliver or review. This region is
   empty most of the time; when it is empty it says so in one line.
2. **Board.** Columns for `queued`, `running`, `review` and recently finished (`done`, `failed`, `cancelled` in the
   last 24 hours). A card shows the title, the Agent, the age in the current state, the first line of the latest
   progress or report, and artifact chips (for example a pull request number). A filter bar narrows by Agent,
   creator, parent Task and text in the title.
3. **Feed.** The newest events across visible Tasks, with kind icons and filters for Agent, Task and kind. The feed
   marks events newer than the viewer's last visit to this page. The first slice keeps the last-visit time in the
   browser; it is a convenience, not shared state.

The page polls every 10 seconds while visible, using the list and Agent-feed cursors, and stops polling when hidden.

## Task page

`/console/tasks/{taskId}` shows:

- A header with title, state, Agent, creator, deadline and parent Task, and the actions the viewer may take.
- The brief, collapsed after its first screen.
- The **timeline**: every event in order. People's messages, questions and reports are full width;
  `progress` events are grouped into a collapsible run ("12 updates over 18 minutes") with the latest one visible.
- The **result**: the latest report, its outcome and its artifacts, pinned above the timeline once present.
- A reply box. Replying to an open question attaches the answer to it; a question with choices shows them as buttons.

Agent-authored text is untrusted: the page renders it as plain text or sanitized Markdown, never as HTML, and links
only to `https` artifact URLs. The page never shows tool output or the full transcript. A person with `administer` on the Agent can follow a link
to the native admin UI, where the session is named after the Task ID; others see the Task feed only.

## Agent page

The existing Agent page gains a **Work** tab: the Agent's current Task, its queue and its recent results, from the
per-Agent feed route. The Agent list gains one column, "Working on", with the current Task title or "Idle".

## States to cover

Storybook stories and screenshots must cover: no Tasks; a Namespace without any Agent the viewer can invoke; a
queued Task waiting behind another; running with progress; a question; a question with choices; stalled; delivery uncertain;
interrupted by a redeploy; review with a pull request artifact; done; failed by deadline; cancelled; the event limit
reached; the viewer without `task:update` (read-only, no actions); loading; and an API error. Storybook proves the
presentation only. Slice 1's integration tests prove the API behavior behind it.

## Accessibility and density

The board must be usable at 390 pixels wide: columns become a state filter and a single list. Every state has a text
label, not only a color. Ages update without layout shift. The page reuses the shared console components and design
language.

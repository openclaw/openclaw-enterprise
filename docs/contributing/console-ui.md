# Console components and styles

Start with the closest page in [Console Storybook](console-storybook.md). The
controller serves [native HTML, CSS, and browser modules](../../apps/controller/src/console/index.html).
Use the [shared DOM helpers](../../apps/controller/src/console/dom.mts) for behavior
and [`console.css`](../../apps/controller/src/console/console.css) for appearance.
Keep resource names, permissions, requests, and recovery in the page that owns them.

Write new browser modules in [strict, erasable TypeScript](console-storybook.md#write-console-modules-in-typescript).
For example, edit `dom.mts` and import it as `./dom.mjs`. The controller serves
JavaScript at that URL. Run `pnpm typecheck` to check the browser code.

## Compose a page

- **Structure.** Let the [shell](../../apps/controller/src/console/shell.mts)
  supply the page title, Namespace, and navigation. Use a `.section` with an
  `h2` to group related content. Add a `.card` when the group needs its own surface.
- **Collections.** Agents and Secrets put search and the primary action in a
  `.collection-toolbar`. Give the search input an accessible name. It comes
  first in markup and in tab order, even when the action wraps below it.
  Use `.resource-id` for an identifier people may need to read or copy.
- **Actions.** Use `button(label, action, { tone: "primary" })` for the main
  action, a plain button for a secondary action, and a link for a destination.
- **Forms and dialogs.** `field({ label, control, help })` connects a label
  and help to the input. In a native modal `dialog`, use `.dialog` and put
  dismissal first in `.dialog-actions`. The `button()` helper defaults to
  `type="button"`. To submit, use a `type="submit"` button associated with the
  form and handle the form’s `submit` event so Enter and clicking take the same path.
- **Feedback.** `statusBlock(tone, label, body)` uses `info`, `success`, `warning`,
  or `danger`. Say what happened and what the person can do next. Before reporting
  success or granting access that depends on a write, verify that the response identifies
  the intended resource and confirms the expected saved state. If the write may have
  committed but you cannot confirm it, say the outcome is unknown and read that same
  resource again. Do not repeat the write to find out.
- **Disabled controls.** Show the reason next to a disabled control, and link it with
  `describeDisabled(control, reason)` wherever the control's state changes, so a screen
  reader reads the reason with the control.

## Extend the shared styles

Use the named roles in `:root`: `--color-link` for links, `--color-accent` for
the primary action, and `--focus-ring` for keyboard focus. Inherit the body
font, pair type sizes with their line heights (for example, `--text-md` with
`--text-md--line-height`), and use the spacing and radius scales.
The [token checks](../../tests/conformance/console-design-tokens.test.mjs)
cover these scales and the supported breakpoints.

Navigation pairs the wordmark with a 48 × 38 px
[mascot for dark surfaces](../../apps/controller/src/console/oce-mascot-inverse.png).
The white contour is part of that artwork and dims with the header under a modal.
On a phone the wordmark scales from 14 to 18 px, leaving room for both 44 px controls.
Sign-in, forced colours, and operator-supplied logos use their original artwork.

Keep a one-page layout with that page. When another page needs the same
pattern, move the shared rule next to the component it extends and use it in
both places. Register new assets in the
[controller's allowlist](../../apps/controller/src/console-assets.ts).
[Storybook](../../scripts/console-storybook/prepare-assets.mjs) prepares its preview
with the same list and asset reader, then simulates API responses for each story.

## Review the result

Rebuild the [affected stories](console-storybook.md#appearance-review), then try
the task at desktop, tablet, and phone widths. Follow the keyboard through the
action and back to its result. Include the state where the next action changes,
such as a refused save or a search with no matches. Use the
[Console browser tests](../../tests/browser/) to load the page through the controller.
Check that new assets load and the interaction works with the actual API. Follow the
[visual review instructions](../../AGENTS.md#console-storybook) for screenshots and video.
Record the interaction with [pr-walkthrough](../../.agents/skills/pr-walkthrough/SKILL.md)
so reviewers can read the starting state, follow the action, and see the result.

# Add issues to a sprint

Use the [sprint view](https://github.com/orgs/openclaw/projects/13/views/2) in
**OpenClaw Enterprise — Releases** to plan work in two-week iterations. You need
write access to the project to add items and change their fields. If you cannot
edit the project, ask a project maintainer to assign the issue.

**Sprint** is a project field of type **Iteration**. Each value has a name and
date range. Adding an issue to the project and assigning its Sprint are separate
steps; a repository label or milestone does not assign a sprint.

## Add an existing issue

1. Open the issue. In its sidebar, edit **Projects** and select
   **OpenClaw Enterprise — Releases**. Skip this step if it is already listed.
2. Open the sprint view. Its saved filter is `sprint:@current`, so an issue without
   a Sprint value may be hidden. Temporarily replace the filter with the issue
   number, such as `733`, to find it.
3. In the issue's row, click the **Sprint** cell. Select the iteration marked
   **Current**, or choose another existing iteration by its date range.
   If the column is hidden, use **Add field → Sprint** to show the existing field.
4. Restore `sprint:@current` in the filter bar. An issue assigned to the current
   iteration now appears in the view. An issue assigned to a future iteration
   appears when that iteration becomes current.

Field edits save immediately. Temporary searches do not need **Save**: saving a
filter changes the default for everyone using that view. You can also use
**Discard** to restore the saved filter; it does not undo the Sprint assignment.

For example, to schedule
[issue #733](https://github.com/openclaw/openclaw-enterprise/issues/733), find its
row and select the current iteration in **Sprint**. Use the date range shown in
the picker rather than assuming that a particular sprint number is still current.

## Create a new task

1. [Create an issue](https://github.com/openclaw/openclaw-enterprise/issues/new/choose)
   in `openclaw/openclaw-enterprise`. Give it a clear title and describe the
   expected outcome and how completion will be checked.
2. Follow steps 1–3 above to add the issue and assign its Sprint.
3. Check the Sprint in the issue’s row and set its assignee and status. Then
   restore `sprint:@current`.

You can also use the **+** control in the project's bottom row to create an issue
or add an existing one. Select `openclaw/openclaw-enterprise` when creating a
repository issue. Verify the Sprint value afterward, even if GitHub populated
it from the view's filter. A draft item exists only in the project until it is
converted to an issue. See GitHub's
[adding items guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project)
for these alternate entry points.

## Move work or find a missing issue

- **Move work to another sprint:** find the issue using a temporary search and
  change its Sprint value. Each item has one value in this field, so moving it
  also changes which historical sprint view includes it. Review unfinished work
  before moving it; the date-based view does not roll it forward automatically.
- **Issue is missing:** check project membership, its Sprint date range, and any
  extra filters. Restore `sprint:@current` to see the current iteration's items.
- **Target iteration is missing:** a maintainer can open project
  **Settings → Sprint → Add iteration** and save the new dates. Reuse the existing
  Sprint field. See GitHub's
  [iteration field guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-iteration-fields).

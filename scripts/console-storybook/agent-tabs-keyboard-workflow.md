# Walk the Agent tabs with the keyboard

The Agent version tabs are a tab list: one Tab stop, arrow keys between tabs,
Enter to open. Use the keyboard, not the mouse.

1. Open **Pages / Agent detail / First version** at desktop width. Tab to the
   tab strip. Focus lands on the selected tab (**Configuration**), and the next
   Tab leaves the strip for the tab's content.
2. Shift+Tab back to **Configuration**. Press Right, Right, Left, End and Home.
   Focus moves between tabs and wraps at either end, but no tab opens and the
   address keeps its `tab=`.
3. Press End, then Enter. **Access** opens, the address shows
   `tab=access`, and the strip marks it selected.
4. Go Back. **Configuration** is selected again and focus moves to it.
5. Press End, then Tab and Shift+Tab. Focus returns to the selected tab, not
   the one the arrows last reached.
6. Narrow the frame to phone width. The strip scrolls sideways. Its right edge
   fades while more tabs are past it, and after scrolling to the end only the
   left edge fades. Press End: the focused tab scrolls into view clear of the
   fade, and stays in view if you resize again.
7. Widen the frame. Nine tabs can still overflow the content column on desktop;
   the fades follow the actual overflow. Where every tab fits, neither edge
   fades, including when browser rounding leaves one scrollable pixel after End.

## Gateway network access

Open **Pages / Agent detail / Gateway network access**. Use the tab strip to reach
**Network**, including at 390px width; arrow keys move focus without discarding
edits. Enter opens the selected tab.

- Select **Required channels and selected hosts**. Reject an invalid host, then
  enter `api.example.com`, save, and reload. The saved draft retains that host.
- While hosts are unsaved, **Deploy** stays disabled and leaving the tab explains
  how to save or cancel. **Cancel changes** restores the saved selection.
- The preparation checklist shows **Unsaved changes** while editing, **Saving…**
  during the request, and **Saved** after a successful save.
- Check **Restricted Gateway access**, **No required destinations**, **Gateway
  network reader**, **Gateway outbound disabled**, **Embedded Gateway networking**,
  **Loading network capabilities**, and **Network capabilities unavailable** for
  their capability and permission states. **Admitted Gateway network snapshot**
  shows an immutable version without editable controls.

These fixtures simulate API and runtime responses. They prove Console behavior,
not backend persistence, deployment or native HTTPS connectivity.

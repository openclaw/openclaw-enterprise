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
   `tab=access`, and the strip marks it selected. To open **Workspace files**
   from Access, press Left four times, then Enter; the address shows `tab=workspace`.
4. Go Back once for each tab you opened. **Configuration** is selected again
   and focus moves to it.
5. Press End, then Tab and Shift+Tab. Focus returns to the selected tab, not
   the one the arrows last reached.
6. Narrow the frame to phone width. The strip scrolls sideways. Its right edge
   fades while more tabs are past it, and after scrolling to the end only the
   left edge fades. Press End: the focused tab scrolls into view clear of the
   fade, and stays in view if you resize again.

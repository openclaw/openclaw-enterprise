# Gateway people walkthrough

Gateway roster stories are under **Pages/Agent detail**, prefixed **Gateway People**:
the populated roster, **Empty**, **Not Configured**, **Loading**, **Error**, **Denied**,
**Stopped**, **Avatar**, **50 People**, **Search People**, and **No Matching People**. Refresh the failed read, check member/maintainer labels,
and repeat at phone width. These fixtures do not establish native profiles or
identity-provider admission; use the installed Gateway proof for that boundary.

1. Build Storybook from the candidate source and open **Pages/Agent detail / Gateway People**.
2. Capture the desktop roster and the same card at 390px. Verify both names and role labels.
3. Open **Gateway People Error**. Select **Refresh people** and verify the two profiles return.
4. Inspect **Empty**, **Not Configured**, **Loading**, **Denied**, **Stopped**, **Avatar**, **50 People**, **Search People**, and **No Matching People**.
5. Open **50 People**. Confirm the overview shows six profiles and the total count.
   Open the panel, search by name, clear the search, scroll, and close with Escape
   and Close. Check focus returns to the launch button; repeat at 390px. Inspect
   **Search People** and **No Matching People**.
6. Record the panel search/close and refresh/recovery interactions. Label these captures as simulated UI proof.
7. Repeat the populated roster and avatar checks against installed OCC after two real humans connect.

Keep captures outside the checkout and attach screenshots and a short walkthrough to the PR.

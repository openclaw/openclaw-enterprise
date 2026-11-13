# Network policy ceiling walkthrough

Open **Pages/Settings → Ceiling Empty**. These stories use the production Console
renderer with simulated API responses. They do not prove PostgreSQL persistence,
IAM enforcement, startup ownership, or Agent runtime traffic.

1. Choose **Add rule**. Enter `/usr/bin/python3.11` for **Executable path** and
   `docs.example.org` for **Destination hostname**. Keep the generated Rule ID
   and the port range `443`–`443`. Choose **Review changes**, inspect the proposed
   rules, then **Save ceiling**. The saved version increases and the notice says
   running access is unchanged.
2. Remove the saved rule and choose **Review changes**. The review warns that
   clearing the ceiling affects future admission and pending applications.
   Choose **Back to editing** to keep the draft without saving.
3. Open **Ceiling Invalid**. The review reports a destination field error and
   keeps the draft. Choose **Edit rule** to inspect the invalid hostname.
4. Open **Ceiling Conflict**. Choose **Load current ceiling**, then **Review
   changes**. Expand **Current saved rules** to inspect the newer baseline. No
   save occurs until **Save ceiling** is chosen again.
5. Open **Ceiling Uncertain**. Choose **Inspect saved ceiling**. A GET confirms
   that the saved version matches the draft; the Console sends no second PUT.
6. Open **Ceiling Permission Lost**. The retained draft is visible, and Add,
   Edit, Remove, Review, and Save controls are absent. **Ceiling Forbidden**
   shows the refusal before any saved value is available. The existing story
   **Driver Configuration Denied** has a known nonadministrator permission
   answer: neither the ceiling nor Driver configuration endpoint is queried.
7. Open **Ceiling Startup**. Confirm **Managed by startup configuration** and
   the read-only rule list. **Ceiling Loading** offers no editor while its read
   is pending; **Ceiling Unavailable** offers **Retry ceiling read**.

Repeat the add/review/save flow with keyboard controls at 1440 px and 390 px.
Check that executable paths and destinations fit, the buttons wrap, the current
focus remains visible, and each error states how to continue. The browser suite
uses the actual controller API for validation, stale saves, lost response
recovery, and permission withdrawal.

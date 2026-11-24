# Deploy a Harness override

Open **Pages/Agent detail → Harness destination override** at desktop width.
The story uses real Console modules and simulated API responses. It does not prove
source authorization, persistence, deployment, or inference routing.

1. Read the requested destination in **Prepare this version**.
2. Open **Harness destination**. Select **Use Installation default** and confirm
   the checklist labels inheritance without claiming a resolved URL. Select
   **Retain v1 requested overrides** to restore the saved request.
3. Select **Override model provider**. Enter an HTTPS endpoint ending in `/v1`,
   select Responses, and leave standalone web search off. Change the URL again;
   the requested destination must follow the field.
4. Select **Deploy new version**. In **Configuration snapshot**, use Tab and
   Enter to open **View overrides** and **View settings**. Confirm both JSON
   documents show the submitted destination. Labels sit above values, and each
   open document takes a whole row. At 390 px, long JSON strings wrap. When you
   deploy with the Installation default, **Requested Harness overrides** shows
   **None** and **View settings** still shows the resolved destination.
5. Open **Harness deployment denied** and submit. Confirm the refusal is visible
   and no new version appears. In **Harness deployment pending**, submit and
   confirm repeat deployment is unavailable while the actual request is held.

Check the default and missing-authentication stories, keyboard focus, and the
phone layout. Reset scroll before full-page screenshots. Capture screenshots and
a short walkthrough outside the checkout, then upload native GitHub attachments.

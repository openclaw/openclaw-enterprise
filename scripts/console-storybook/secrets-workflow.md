# Console Secrets walkthrough

Rebuild Storybook from current source. Open **Pages/Secrets → Populated**.
These fixtures demonstrate UI behavior; they do not prove backend persistence,
Kubernetes storage, credential delivery, or runtime consumption.

1. Search by name or ID. Press Tab from **Search Secrets** to **Create Secret**.
   At phone width, Create wraps below search and keeps that tab order. Open
   **No search matches**, then clear the search to recover the list. Switch Namespace and back.
2. Create **Walkthrough key** with a synthetic value. Inspect masking, reveal and
   hide it, then submit. Close the success message and open its detail.
3. Replace the value and inspect the deployment and CredentialSource instructions.
   After success, reopen replacement and check that its input is empty.
4. Delete the unreferenced Secret after reviewing the confirmation. Verify that
   it leaves the list.
5. Open **Consumers and restricted references**. Inspect the Agent link, other
   IDs, hidden count, and incomplete-list notice. Check that the previously
   listed Agent shows no identity or link and asks you to reopen the Secret to
   check again, without claiming why it is no longer listed. The inspector says
   “This Secret is referenced.” Tab to the unavailable **Delete Secret** and
   check that its description uses that sentence.
6. Open **Read only for this caller**. The same usage sentence appears beside
   the separate access notes. Tab to **Delete Secret** and check that its
   description includes both the usage sentence and the delete permission note.
   **Replace value** is also unavailable and has its own permission note.
7. Open **Concurrent reference conflict**. The inspector says “No current
   consumers were found.” Choose **Delete Secret**, then **Permanently delete
   Secret**. The refusal names the reference and asks you to remove it, then close
   and reopen the Secret to check its current consumers. The same confirmation
   cannot submit again.
8. Inspect **Missing value**, **Create denied**, **Replace denied**, and
   **Unknown save outcome**. Uncertain submissions must remain disabled.
   Close, then refresh or inspect current state as instructed.
9. Inspect **Empty**, **Loading**, **Read unavailable**, **No readable Namespace**,
   and **Namespace provisioning**. In **Create not permitted**, Create Secret is
   disabled and the access note under the toolbar is its description.
10. In **Mobile** (390 × 844), open the single search result, then **Replace value**.
    The header and sheet reach the right edge without an empty strip. Press Escape,
    clear **Search Secrets**, scroll to the last Secret, and open it. A classic
    scrollbar takes its usual space; an overlay scrollbar takes no extra width.
    Escape returns focus to the Secret you opened. Repeat creation and deletion
    in this phone layout.

Capture final desktop/mobile screenshots, consumer and failure states, and a
short create/replace/delete recording outside the checkout. Record the tested
revision and attach the media to the conversation and eventual PR verification.
For usage changes, capture the referenced, read-only, and no-consumers
inspectors and record the confirmed delete through the reference refusal.

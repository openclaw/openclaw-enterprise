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
   IDs, hidden count, incomplete-list notice, and disabled deletion.
6. Inspect **Missing value**, **Create denied**, **Replace denied**, **Unknown save
   outcome**, and **Concurrent reference conflict**. Uncertain submissions must
   remain disabled. Close, then refresh or inspect current state as instructed.
7. Inspect **Empty**, **Loading**, **Read unavailable**, **No readable Namespace**,
   and **Namespace provisioning**.
8. In **Mobile** (390 × 844), open the single search result, then **Replace value**.
   The header and sheet reach the right edge without an empty strip. Press Escape,
   clear **Search Secrets**, scroll to the last Secret, and open it. A classic
   scrollbar takes its usual space; an overlay scrollbar takes no extra width.
   Escape returns focus to the Secret you opened. Repeat creation and deletion
   in this phone layout.

Capture final desktop/mobile screenshots, consumer and failure states, and a
short create/replace/delete recording outside the checkout. Record the tested
revision and attach the media to the conversation and eventual PR verification.

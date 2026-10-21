# Console Secrets walkthrough

Rebuild Storybook from current source. Open **Pages/Secrets → Populated**.
These fixtures demonstrate UI behavior; they do not prove backend persistence,
Kubernetes storage, credential delivery, or runtime consumption.

1. Search for a Secret name and ID. Clear the search. Switch Namespace and back.
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
   and **Namespace provisioning**. Repeat the creation and deletion controls in
   **Mobile** at 390 × 844.

Capture final desktop/mobile screenshots, consumer and failure states, and a
short create/replace/delete recording outside the checkout. Record the tested
revision and attach the media to the conversation and eventual PR verification.

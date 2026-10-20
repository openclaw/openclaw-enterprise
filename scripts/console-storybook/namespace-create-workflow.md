# Create a Namespace

These stories use production console components with simulated API responses.
They do not prove authorization, persistence, worker provisioning, or runtime
readiness. The browser integration suite uses the real controller and IAM with
in-memory storage for those API boundaries.

1. Open **Pages/Namespaces → Ready and provisioning**. Select **Create Namespace**.
   Enter a unique name, create it, and inspect **Namespace created**. Select
   **Done**: its card reads **Provisioning**. Repeat with another name and select
   **Open Agents**: the Namespace selector names the new Namespace. After
   **Done** or Escape, focus is on **Create Namespace**.
2. Open **Empty**. Creation is available even without a readable Namespace. In
   **Create Namespace Mobile**, inspect the bottom sheet at 390 × 844 and
   verify that the field and both actions fit. Cancel or press Escape: the form
   closes without creating anything and focus returns to its opener.
3. Open **Create Required**: the inline error describes the focused field.
   In **Create Invalid Name**, the pasted tab is refused at the field; replace
   it with a space and the error clears. More than 200 characters is refused too.
   In **Create Conflict**, change the retained name and resubmit. In
   **Create Denied**, inspect the access guidance and disabled submit.
4. Open **Create Pending**. Escape cannot dismiss a pending write. After the
   timeout, or in **Create Unknown**, submission is disabled. Select
   **Check Namespaces** to inspect the list before starting another attempt.
5. Open **Create Unreadable**: a create-only caller sees that the Namespace
   was created, that their access does not include viewing it, and only **Done**.

Capture desktop and phone screenshots and a short creation walkthrough outside
the checkout. Attach them to the task and the PR's Verification section. Record
the tested revision and label this evidence as simulated UI proof. Namespace
renaming, deletion, and infrastructure placement are outside this workflow.

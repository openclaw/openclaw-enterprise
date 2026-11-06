# Preview and deploy a Harness override

Open **Pages/Agent detail → Harness destination override** at desktop width.
The story uses real Console modules and simulated API responses. It does not prove
source authorization, persistence, deployment, or inference routing.

1. Read the retained evaluation destination in **Prepare this version**.
2. Select **Override model provider**. Enter an HTTPS endpoint ending in `/v1`,
   select Responses, and leave standalone web search off.
3. Select **Preview destination**. Confirm the endpoint and protocol shown.
4. Select **Deploy new version**. Open the version details and confirm requested
   overrides and resolved settings identify the selected destination.
5. Open the loading, permission-denied, and unavailable stories. Deployment must
   stay unavailable until preview succeeds. Retry the unavailable story.

Use the first-version and missing-authentication stories to check empty settings
and missing credentials. Check keyboard focus on the selector, provider fields,
preview action, and deployment action. Capture screenshots and a walkthrough
outside the checkout, then upload the final media for review.

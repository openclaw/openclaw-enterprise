# Direct Control UI access

These stories use the production Agent detail page with simulated HTTP responses.
They show configured OIDC identities, not live connections or identity-provider
eligibility. The roster belongs to the **current serving Gateway**, not the saved
version selected on the page. The API provides no serving revision metadata.

## Review the Access workflow

1. Open **Pages/Agent detail → Gateway People**. Direct Control UI access is first
   on Access. Names, exact configured OIDC identities, and known Gateway roles are
   inline. The never-connected identity has no invented profile or role.
2. Compare **Share Agent through OCC** below it. Its form and direct Agent grants
   stay together. Agent-wide scope and the native-administration warning apply to
   OCC sharing, not the direct Gateway list. Do not submit sharing changes.
3. Search by friendly name, then by the long configured identity. Clear the search.
   Open **Gateway People Large** and scroll its compact inline list. Verify a
   no-match search without opening a drawer or preview.
4. Inspect desktop 1440 × 1000, tablet 768 × 1024, and phone 390 × 844. Identities
   wrap without horizontal overflow; large lists scroll inside the card.
5. Open **Gateway People Loading**, **Error**, **Denied**, **Access Granted**,
   **Empty**, **Not Configured**, **Never Connected**, and **Stopped**. Loading or
   failed direct-user reads must not block OCC sharing. Refresh users retries an
   ordinary failure. The page Refresh clears a cached authorization denial.
6. Return to Configuration and confirm no roster is shown there. Re-enter Access:
   it revalidates independently of the retained sharing form. An overview or an
   unrelated tab must not initiate a roster read.

Capture comparable Access before/after images and a 15–30 second overview →
Access → identity search → refresh walkthrough using
[recordWalkthrough](../console/record-walkthrough.ts). Keep evidence in approved
untracked scratch; report story names, source revision, environment, and limits.
Storybook demonstrates simulated UI behavior only; it does not prove real Gateway
persistence, runtime configuration, or credential propagation.

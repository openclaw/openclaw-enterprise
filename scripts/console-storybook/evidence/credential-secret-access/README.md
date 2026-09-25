# Credential Secret access evidence

Captured September 25, 2026 from the credential fix based on `5f2f3a74`, using a
fresh Storybook build and headless Chromium 153.0.8010.12 on Linux at 1440 × 1000.
These are simulated UI fixtures, not proof of backend persistence, live deployment,
credential delivery, or model execution. Only dummy data appears.

The [11-second walkthrough](credential-recovery.webm) saves a replacement token
Secret, shows a denied grant, retries access without another Agent PATCH, and
shows unknown-save, deployment-denied, and pending-grant states. The recording
was decoded successfully; all six previews completed without browser errors or
unhandled fixture requests.

Stories and screenshots:

- Components/Credentials → Replace model Secret: [saved replacement](replacement-saved.png).
- Components/Credentials → Authentication saved, grant denied: [partial save](grant-denied.png) and [successful retry](grant-recovered.png).
- Components/Credentials → Authentication save unknown: [refresh required](save-unknown.png).
- Components/Credentials → Checking model Secret access: [pending grant](grant-pending.png).
- Pages/Agent detail → Deployment denied: [persistent denial](deployment-denied.png).

The separate browser regressions use real Fastify, Better Auth, and Native IAM
with in-memory state and fixture Drivers. They prove exact grants, actor denial,
retry behavior, and deployment admission feedback, not a real runtime.

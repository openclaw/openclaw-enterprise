// GitHub installation tokens expire one hour after issuance. Response receipt
// starts a conservative cleanup bound even when the local wall clock changes.
export const tokenLifetimeMs = 3600000;
export const providerClockSkewMs = 60000;

// GitHub accepts an App JWT for at most ten minutes (ours expire 300 s after signing), and an
// issue attempt dispatches at most once, within 25 s of its durable intent. So no token from an
// attempt can be live later than this after the intent committed, whatever its response was.
export const appJwtMaximumLifetimeMs = 600000;
export const issueAttemptLiveBoundMs =
  appJwtMaximumLifetimeMs + tokenLifetimeMs + providerClockSkewMs;

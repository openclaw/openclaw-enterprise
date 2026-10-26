// GitHub installation tokens expire one hour after issuance. Response receipt
// starts a conservative cleanup bound even when the local wall clock changes.
export const tokenLifetimeMs = 3600000;
export const providerClockSkewMs = 60000;

// An issue attempt signs its App JWT, then confirms in the database's own clock that its durable
// intent is younger than this window, then dispatches at most once (within a 25 s budget).
export const issueAttemptDispatchWindowMs = 60000;
// GitHub refuses an App JWT whose expiry is more than ten minutes ahead of its clock; ours expire
// 300 s after signing, by a worker clock that may not run more than two minutes ahead of the
// database's before dispatch. Ten minutes covers that lifetime, those two minutes and the
// database's skew from GitHub. So GitHub cannot mint for an
// attempt later than the window plus ten minutes after its intent, and the token lives at most an
// hour more: no token from an attempt is live after this bound, whatever its response was, even
// if the worker's host was suspended mid-attempt.
export const appJwtMaximumLifetimeMs = 600000;
export const issueAttemptLiveBoundMs =
  issueAttemptDispatchWindowMs + appJwtMaximumLifetimeMs + tokenLifetimeMs + providerClockSkewMs;

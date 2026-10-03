# Push-ref guardrail

Set `pushRefAllowlist` on a repository's Namespace policy in the
[credential registry](../repository-credentials.md#canonical-platform-registry)
to catch accidental branch pushes, such as pushing directly to `main`:

```json
{
  "namespaceId": "team",
  "profiles": ["git-write", "git-full"],
  "pushRefAllowlist": ["refs/heads/agent/*"]
}
```

Use actual Namespace IDs. This example permits `agent/feature` but rejects
`main`. The policy applies to every selected profile in that Namespace;
it does not add token permissions or change GraphQL access.

## Matching and delivery

- Entries are case-sensitive full branch refs: an exact `refs/heads/release`,
  or a prefix ending in `/*`, such as `refs/heads/agent/*`.
- Omission preserves existing push behavior. An empty array denies all ref
  updates through the managed hook.
- Creation, deletion and force updates use the same destination-ref check.
  Tags are not branch refs and are denied. One disallowed ref rejects the
  entire push before ref updates; discovery and authentication may already occur.
- Native HTTPS destinations retain the check with or without `.git`, trailing
  slashes, or the configured Git username. Host and repository matching remains
  exact; a username cannot select among duplicate repository bindings. A
  gateway destination with an encoded username, embedded password, query or
  fragment fails the guard when a repository it may name has a policy.
- Entries are sorted and deduplicated into the admitted grant fingerprint.
  There is no separate entry-count or per-entry byte cap; the complete serialized
  client metadata must fit its existing 16 KiB limit.

The generated Git configuration selects image-owned hooks. Ordinary hooks in the
repository's common Git directory still run, including for linked worktrees.
Repository initialization works before the initial `HEAD` exists.
Standalone sessions with this policy require the emitted client from
`pnpm credentials:build`.

## Limits

This is a convenience guardrail, **not a security boundary**. Native hook/config
overrides, bypassing hooks, alternate clients, direct REST/GraphQL writes and
merges are outside it. A custom `core.hooksPath` replaces the managed directory;
custom hooks must explicitly chain the image dispatcher to retain the check.
Use GitHub repository rules for server-side controls.

`repository-push-ref-not-allowed` means at least one destination is outside the
allowlist. Choose an allowed branch. `repository-pre-push-guard-failed` means the
guard could not safely check the push; inspect the selected binding, session and
hook configuration. Neither result forwards ref updates. Do not retry an
uncertain remote mutation without inspecting its result.

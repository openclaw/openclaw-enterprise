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
- Branch names may use any UTF-8 text Git's refname rules accept, such as
  `agent/café`. Matching compares bytes exactly, with no Unicode normalization
  or case folding: an entry spelled with a composed `é` (U+00E9) does not match
  a push to the decomposed `e` + U+0301, though both render alike. Write entries
  in the spelling your clients push. A ref that is not valid UTF-8 or contains
  a control character (C0, DEL or C1) is refused.
- Invisible and direction-changing characters are refused in refs and entries,
  even under an allowed prefix: bidi controls (U+061C, U+200E-U+200F,
  U+202A-U+202E, U+2066-U+2069), zero-width characters (U+200B-U+200D, U+2060,
  U+FEFF, so also emoji joined with U+200D), and U+2028 and U+2029. The hook
  names the refused character.
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

## Enforce the ref policy at the gateway for a GitHub App

To give an Agent native Git read access and permission to push one review branch,
set this policy on the repository in its Namespace's credential registry:

```json
{
  "namespaceId": "team",
  "profiles": ["git-write"],
  "transport": "git-only",
  "pushRefAllowlist": ["refs/heads/review/example-123"]
}
```

Select the `github-prepared-git-registry` backend for this policy. The Agent uses
the ordinary `git-write` binding and a scoped gateway session. The prepared
credential owner mints the repository-scoped GitHub App installation token in
the background with `metadata: read` and `contents: write`. The gateway admits
only Git discovery, fetch and push for this repository, and checks every proposed
ref before sending any part of a push to GitHub. REST and GraphQL are unavailable
through this session. The prepared backend requires exactly one branch ref; an omitted, empty,
wildcard, or multi-ref allowlist is an error. Changing this transport or its ref
changes the grant identity; close old sessions when narrowing access. See
[Prepared native Git](prepared-native-git.md) for the credential lifecycle and
deployment requirements.

The branch restriction is enforced by this gateway, not encoded in the provider
token. The allowlist admits creation, updates, force pushes and deletion of the
named branch, subject to the repository's own rules. Reading is repository-wide.
Use a new disposable branch or a disposable repository with appropriate workflow
and secret policies. This setting grants no Sandbox or network access on its own.

## Gateway enforcement for the development token authority

With the [development token authority](development-token.md), the same allowlist
is also enforced by the gateway. It reads the receive-pack commands before any
byte goes upstream and refuses the whole push with HTTP 400 when one ref fails,
so `--no-verify` or a replaced `core.hooksPath` changes nothing. The client hook
still gives the first, friendlier refusal. No admitted REST route writes refs,
and GraphQL mutations are refused for this authority, so the allowlist bounds
every ref write. The client hook alone is not a security boundary.

The gateway also limits one push to 256 refs and refuses a larger push with
HTTP 413 `push-ref-limit-exceeded`, even when every ref is allowed. The client
hook does not count refs, so this refusal comes from the gateway. Push the refs
in batches of 256 or fewer.

## Limits

The client hook is a convenience guardrail, **not a security boundary**. Native hook/config
overrides, bypassing hooks, alternate clients, direct REST/GraphQL writes and
merges are outside it. A custom `core.hooksPath` replaces the managed directory;
custom hooks must explicitly chain the image dispatcher to retain the check.
Use GitHub repository rules for server-side controls.

`repository-push-ref-not-allowed` means at least one destination is outside the
allowlist. Choose an allowed branch. `repository-pre-push-guard-failed` means the
guard could not safely check the push; a fixed reason code such as
`invalid-repository-material` follows when one applies. Inspect the selected
binding, session and hook configuration. Neither result forwards ref updates. Do
not retry an uncertain remote mutation without inspecting its result. When a Pod's
session material cannot be read, only pushes to plainly spelled HTTPS hosts other
than every binding's gateway and canonical origin proceed; a single-session
launcher refuses them all.

Other dispatcher failures print `repository-hook-failed`, the hook name and a
reason code. Push-to-checkout refusals print Git's own reason, while the ref
status reads `push-to-checkout hook declined`. A forwarded hook killed by a
signal exits with 128 plus the signal number, as in Git, and the message names
the hook instead of its path.

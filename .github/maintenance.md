# Repository maintenance proposal

This is a proposed settings checklist for `openclaw/openclaw-enterprise`, not a
record of applied controls. Merging this document changes no GitHub setting,
registry permission, subscription, or release authorization. A repository or
organization administrator must review and explicitly apply each setting.

Before making changes, inspect the live repository and organization policies.
Record the approved values and verify them afterward. Do not replace a stronger
existing control or enable a paid feature without approval.

## Actions permissions

In **Settings > Actions > General**:

- Select the read-only default for `GITHUB_TOKEN` workflow permissions.
- Disable **Allow GitHub Actions to create and approve pull requests**.
- Keep fork workflow access, write tokens, and secrets disabled unless an
  explicitly reviewed use case requires them.
- Review the actions allowlist against the actual workflow dependencies before
  restricting it. Require full commit SHA action pins after checking compatible
  organization policy.

Workflows should declare read-only permissions by default and grant additional
permissions only to the job that needs them. Disable persisted checkout
credentials. Untrusted PR code must not receive publication credentials.
Ordinary checks do not need package publication or repository write access.

## Reviews and branch protection

Proposed protection for `main`:

- Require a pull request and at least one approving review.
- Require code-owner review; keep `@openclaw/maintainer` and
  `@openclaw/openclaw-secops` visible to repository members with explicit write
  access or greater.
- Dismiss stale approvals on new commits, require approval of the latest
  reviewable push by someone other than its pusher, and require resolved review
  conversations.
- Block force pushes and branch deletion. Review administrator and application
  bypasses explicitly; avoid standing automation bypasses.
- Require the current approved CI result on the exact merge candidate.

CODEOWNERS routes reviews; it does not enable enforcement. The final matching
line wins, and multiple owners on one line mean approval from either owner,
not all of them. Security-only ownership entries are needed where secops
approval is intended. Protect CODEOWNERS itself.

### Required CI context

[PR #23](https://github.com/openclaw/openclaw-enterprise/pull/23) defines the
aggregate job **`CI Required`** in the **`CI`** workflow. The reviewed source is
[`ci.yml` at `f00e5992db67b417ac6f4136dabd5e6585f4b8a2`](https://github.com/openclaw/openclaw-enterprise/blob/f00e5992db67b417ac6f4136dabd5e6585f4b8a2/.github/workflows/ci.yml).
It aggregates Suite Audit and the five unprivileged test lanes, including their
result artifacts.

Do not require this context until its producer is merged, enabled, and has
reported successfully on a real candidate. Select the observed `CI Required`
check from GitHub Actions in the ruleset rather than guessing a display prefix
or copying `openclaw/ci-gate` from another repository. Confirm skipped or failed
required lanes fail the aggregate. Recheck the context if PR #23 changes before
merge. Its protected full-integration workflow is separate; a PR-safe pass is
not proof that credentialed model suites ran.

## Private container publication

No image may be published merely because a workflow PR is approved. Before
enabling GHCR or Docker Hub publication:

1. Approve exact Enterprise controller and runtime destinations in each registry.
   Verify repository/package ownership, private visibility, and allowed readers.
   Do not reuse public OpenClaw image names or silently fall back to a public
   destination.
2. Create a dedicated publishing environment with required reviewers,
   self-review prevention, and deployment restrictions matching the approved
   release refs. Verify these protections are available under the repository's
   plan. Do not reuse or weaken integration-test environments.
3. Scope credentials to the approved destinations and publishing jobs only.
   Review GHCR package access for this repository and Docker Hub token authority.
   Do not add credentials to build jobs, PR jobs, logs, or artifacts.
4. Review the immutable source SHA and trusted workflow revision. Require
   successful evidence for that exact source, approved digest-pinned base images,
   intended architectures, and the existing image startup/packaging checks.
5. Separate unprivileged preparation from protected publication. Publish only
   the reviewed artifact digests; promote the same digests to Docker Hub without
   rebuilding. Serialize writes and fail closed on mismatched or missing inputs.
6. After an explicitly authorized first publication, verify private visibility,
   digest identity, pull access, and audit evidence in both registries. Record
   any untested surface rather than calling configuration alone release proof.

The publication workflow owns its concrete environment, variable, and secret
names. Configure only its reviewed interface; this proposal does not create one.

## Code scanning and dependency updates

Private-repository CodeQL scanning requires GitHub Code Security availability
and enablement under the organization's plan. Confirm entitlement and cost with
an organization administrator before enabling it. A CodeQL configuration PR
alone neither enables scanning nor establishes that the repository is clean.

After authorized enablement, run the reviewed JavaScript/TypeScript and Actions
analyses and inspect the resulting alerts. Reproduce findings against the actual
source and ownership boundary before opening focused fix PRs. Handle exploitable
details through the private security team; do not invent findings from an empty
or inaccessible alerts page. Require scan results only after successful producers
and stable contexts exist.

Dependabot version updates are separate from security-alert enablement. Review
weekly npm-workspace and Actions updates through ordinary PR checks and owner
review. Do not enable automatic merging or share publication secrets with the
dependency updater. Verify its first run can read the pinned pnpm workspace and
lockfile without rewriting them into a different package-manager format.

## References

- [Workflow permissions and repository Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [CODEOWNERS behavior and required reviews](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- [Code scanning availability](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning)

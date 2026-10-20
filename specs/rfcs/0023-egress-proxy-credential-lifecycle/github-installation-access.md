---
rfc: index.md
---

# GitHub installation access through the online OpenShell sender

**Part of RFC-0023.** This proposal makes installation-wide access and standing team approval separate, explicit choices. It preserves existing finite grants and does not claim that stock OpenShell meets all of the online qualification requirements.

## Decision

Let an Installation operator grant an Agent the GitHub App installation's actual repository and API permissions. OCE owns admission, the App signing key, issuance, current authorization, withdrawal and retirement. OpenShell remains the only sender and owns credential injection. No separate public Git relay, personal access token or secret in the workspace.

The current prepared Git mode issues a token for one repository, checks one writable ref, and permits one controlled draft. It cannot support routine multi-repository engineering, issues or arbitrary review branches. Keep that mode unchanged. Add a distinct installation-wide policy; never infer it from a missing ref or a wildcard. A Namespace policy and an explicit Agent binding must select it. Changing mode changes the grant fingerprint and requires a new revision and installed material. Do not adopt an earlier narrow token or widen an existing execution on restart.

For installation access, issue a GitHub installation token without `repository_ids` or permission overrides, so GitHub's App installation remains the permission ceiling. Validate the returned token, expiry, repository selection and permission response according to the issuance mode; retain cleanup ownership for rejected or uncertain issuance. The existing single-repository validation remains strict. Separate installation-wide material from narrow material in durable identity, validation and retirement. Never expose installation-wide material through the native repository broker's token-returning operation.

An admitted Agent may use Git smart HTTP for reads and writes on github.com and the ordinary GitHub REST and GraphQL APIs on api.github.com (including the GraphQL operations used by `gh`). No OCE branch, PR-head or draft-only filter applies in this mode; GitHub's installation permissions, branch protection and repository rules still apply. Public Git reads and public REST reads may use the same token. GitHub's exact handling of an explicitly narrowed token on unrelated public repositories is not assumed. For the installation-wide mode the operator has deliberately authorized every private repository the App can access as well. This is **not** a public-only guarantee.

Use a GitHub-host-scoped credential helper and the existing nonsecret OpenShell marker, support ordinary Git and `gh`, and enforce verified HTTPS, the admitted sandbox/installed generation and a current OCE grant on each request. Never inject on another host or redirects to it. Reserve token issuance/retirement to the credential owner; do not expose the App JWT, token endpoint or a generic proxy. Do not interpret a failed or truncated middleware body as an approved operation; document transport size limits and qualify actual pack traffic. API operations may have external effects: an allow is not proof of delivery, and ambiguous writes must be reconciled rather than automatically retried. The existing one-draft receipt is not an installation-wide API deduplication mechanism.

A later independently selected **public-read-only** policy must not inherit installation-wide private reads. It needs an enforceable public-visibility boundary (or material demonstrably unable to read unapproved private repos), read-only methods including Git upload-pack, and the same OCE/OpenShell sender. Merely permitting GET or checking that GitHub returned 200 does not establish public visibility. Do not advertise this narrower policy until tested.

## Acceptance

- Default and existing bindings preserve current narrow issuance, ref and draft restrictions. Unbound or withdrawn executions fail closed, even with a still-valid provider token. Switching modes cannot reuse another Agent's or revision's material.
- From one installed Agent, read an unrelated public repo via REST and Git (including an object transfer); read/write an installed repo and open/update a normal PR and issue. Use controlled repositories for API mutation and branch-protection denial. No forced merge or bypass.
- Verify GitHub refuses a private repository outside the installation. Report actual authenticated REST rate-limit accounting separately from Git traffic. Verify credentials never reach a different host, including redirects.
- Retain stock middleware/transport qualification limits. Separately measure maximum viable Git/REST/GraphQL request sizes. No credential-free fallback or second egress route is introduced by this change.

## Let a team keep Git access until it removes approval

A team installs an Agent on Monday and fetches new commits in the same conversation on Tuesday.
An authorized team member approves that access once. OCE keeps the approval until it is removed
and prepares short-lived GitHub installation tokens as needed. The team does not renew approval
every hour, deploy a new Agent revision, or give the Agent a long-lived token.

**Approval duration and GitHub permissions are separate choices.** Keep the current finite grant
and its absolute deadline as the default, including for every existing binding and stored session.
Offer an explicit _until removed_ choice only to a principal who may grant that duration and scope
under current Installation and Namespace policy. Show who approved it and how to remove it.
Record the choice, approval ID and generation, and the exact team Namespace, Agent, binding and grant:
GitHub App, installation, repository selection, allowed refs and API permissions. A team can keep
access to one repository and review branch without granting installation-wide access. Missing or
unrecognized duration cannot select standing approval. Do not encode it as a distant deadline.

**Use the approval.** The worker and repository credential service currently bind an admitted
revision and its session to the same absolute deadline. Change both contracts. Keep each session,
request and token time-limited; OCE may establish the next finite session under the same approval.
Before preparing or installing material, verify the approval generation, current policy, active
Agent revision and exact execution. Renew in the background early enough for ordinary Git to
continue. Use the existing OpenShell dynamic grant and [online authorization](online-authorization.md)
where qualified. On every request, verify the signed sandbox identity against that execution and
check the actual operation against current authority. Record a material version and expiry, never
the token. Report any connection interruption during renewal; the conversation must remain usable.

**Stop using the approval.** Commit removal and advance its generation before acknowledging it.
Deny the next authorization even while GitHub would accept the token. Stop preparation, detach
the Git credential and retire issued material through the existing [withdrawal protocol](protocol.md#withdraw-and-recover).
Report those outcomes separately. An already authorized request can still arrive; removal cannot
erase a clone, undo a push or recall a bearer token. Policy loss also denies new use. Stopping the
Agent closes that execution's authority. An explicit resume needs a fresh admission against approval
that is still current; neither resume nor replacement can adopt a stopped or revoked execution's grant.

**Recover without restoring old authority.** A worker restart may resume the same approval and
verified execution. Record the owner, approval generation and attempt before issuing or installing a token.
An identical operation returns its recorded outcome. Commit a result only while that owner and
generation are current, so a late writer cannot undo removal. After a lost reply, inspect that attempt; never repeat an
uncertain mint, installation or Git write. If OCE cannot establish current authority and eligible
installed material, deny Git and report what needs recovery. Granting access again creates a new
approval generation; restart, policy restoration or token renewal cannot revive a withdrawn one.

### Prove the same Agent can still fetch after the old deadline

1. Grant standing access once. From an installed team Agent, fetch a known Git object into an empty
   object store. Record the Agent, revision, execution, conversation, approval generation and
   nonsecret material version. Keep existing push and pull request evidence unless another write is authorized.
2. After the former one-hour deadline has actually passed, use that conversation to fetch an object
   absent locally. Verify object transfer, unchanged identities and a different short-lived material
   version installed under the original approval. An allow decision alone cannot identify the token
   OpenShell sent. Exercise the time boundary with a controlled clock locally; record real elapsed time separately.
3. Remove approval while the latest token would still be valid. Show a fresh fetch denied before any
   provider request, and a reply in the same conversation if chat remains authorized. Also cover policy
   loss, stop and explicit resume, replacement, stale renewal, failed or uncertain issuance, and the
   existing finite grant expiring on schedule.

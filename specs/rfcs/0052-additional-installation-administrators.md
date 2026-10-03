---
status: Proposed
status_note: "Needs human review before landing. This PR changes documentation only; it implements no option."
---

# Proposal: Additional Installation administrators

- **ID:** RFC-0052
- **Owner:** IAM and authentication. Review: IAM model owners.
- **Created:** 2026-10-02
- **Last updated:** 2026-10-02
- **RFC PR:** this PR (draft)
- **Related:** finding D245 from live testing of #281 and #624; current contracts in
  [authentication](../../docs/reference/authentication.md#account-provisioning),
  [authorization](../../docs/reference/authorization.md) and
  [Add a person](../../docs/guides/topics/iam.md#add-a-person).

## Summary

`POST /api/auth/accounts` with the built-in administrator `roleId`
(`role_admin_<uuid>`) creates an account that the docs call "another
Installation administrator". It is not one. The account seed binds the Role to
the exact Installation resource (`resourceKind: installation`), and an exact
binding grants only Permissions whose kind matches its target. Of the Role's
Installation, Namespace, Agent, Secret and other Permissions, only
`installation:administer` and `installation:read` ever apply. The bootstrap
administrator's binding has no target, so the same Role grants it everything.

This RFC decides what the administrator `roleId` should grant. It recommends
seeding the same unscoped binding as bootstrap, guarded by the #624 coverage
rule at account creation. Until a decision lands, this PR corrects the docs.

## Motivation

On the dogfood install, an account created with the administrator `roleId`
could create accounts and read `/observability`. It got `GET /namespaces` → `[]`, `403` on `POST /namespaces`,
on reading any Namespace or its IAM policy, and on the deployment inventory.
Namespace Roles allow only `namespace:read`, so no Namespace grant can give it
Namespace create or delete either. Only the bootstrap human and the bootstrap
ServicePrincipal can create or delete Namespaces, so an Installation with one
human administrator has a single point of failure.

The exact binding is deliberate in `createAuthPrincipalSeed`
(`packages/iam/src/index.ts`) and enforced by
`validateAuthAccountPrincipalSeed`. Its effect is not documented.

## Goals

- An account created "as another Installation administrator" can do what the
  bootstrap administrator can do, or the docs say plainly that it cannot.
- No caller can create an account that holds grants the caller lacks (the #624
  rule, applied to account creation).
- Existing accounts do not gain access silently.

## Options

### A. Seed an unscoped binding, with a coverage check (recommended)

- `createAuthPrincipalSeed` binds an existing `roleId` with no target, like the
  bootstrap binding. `validateAuthAccountPrincipalSeed` accepts only that shape.
- `POST /api/auth/accounts` with a `roleId` requires the caller to hold every
  grant the new binding confers: an unscoped binding of the same Role, or an
  equivalent check over the Role's Permissions. Today an account holding only
  the exact-Installation binding can create other accounts with this `roleId`;
  without the check, Option A would let it mint a full administrator.
- Existing exact-Installation account bindings stay as they are. An operator
  who wants a full second administrator creates a new account, or deletes and
  recreates the binding through a documented migration step. No automatic
  rewrite, because that would grant access nobody approved after the fact.

Cost: one authorization rule on account creation and a contract change in what
the documented `roleId` grants. Audit already records `roleId`.

### B. Treat an Installation-targeted binding as covering everything in it

Make the evaluator apply a binding targeted at the Installation to every
resource in it. This changes the meaning of every existing Installation binding
at once, including the accounts created so far, and makes "exact" targets
mean something different for one kind. Not recommended.

### C. Keep the exact binding and document it

The administrator `roleId` then means "account and service key administration
only". This needs no code. It leaves a single human able to manage Namespaces,
and the Role name "Installation administrator" stays misleading for these
accounts. A separate, narrower built-in Role (for example "Account
administrator") would make the intent explicit but adds API surface.

## Decision requested

1. Choose A, B or C.
2. For A: confirm the account-creation coverage rule, and whether existing
   exact-Installation account bindings get a documented migration step.

## This PR

Documentation only, so the shipped behavior is described correctly now:
`docs/reference/authentication.md` and `docs/guides/topics/iam.md` say that the
administrator `roleId` on an additional account grants account administration
and Installation reads only, not Namespace or Agent access. If Option A lands,
those sentences change with it.

## Risks

- Option A widens what an administrator `roleId` grants for new accounts. The
  coverage check keeps it from exceeding the creator's own access.
- Option C keeps today's behavior; operators who need a second full
  administrator have none.

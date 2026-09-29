# IAM overview

Identity and access management (IAM) controls who can read, create, change, or
operate OpenClaw Enterprise resources. Signing in identifies a caller; it does
not grant access. OpenClaw Control Plane (OCC) checks each action against the
caller’s current permissions and the exact Installation, Namespace, or resource.
Without a matching grant, OCC denies the request. A matching Restriction also
overrides a grant.

## Choose an identity

- **People** sign in with an administrator-provisioned email and password. See
  [Authentication](../../reference/authentication.md) for sign-in and account
  provisioning, and [external sign-in](../../reference/authentication/external-sign-in.md)
  for GitHub or Google sign-in of enrolled accounts. Public signup and generic
  OIDC are not supported.
- **Non-Agent automation** authenticates as an existing ServicePrincipal with a
  [service API key](../../reference/authentication/service-api-keys.md). Issuing
  a key does not give that identity new permissions.
- **Agents** have their own Namespace-scoped ServicePrincipal. That identity is
  separate from the user who creates or deploys the Agent. Agent-owned
  principals cannot use service API keys. See
  [Agent permissions](../../reference/authorization.md#principals).

[Service accounts](../../reference/service-accounts.md) are a separate feature:
Agents can use them for upstream credentials, such as a Backend-issued model
credential. A service account is not an IAM ServicePrincipal.

## Grant and check access

Permissions are assigned through Roles and AccessBindings. Installation
administrators can create human accounts bound to an existing Role and manage
Namespace Roles and AccessBindings through the [HTTP API or CLI](../../reference/authorization.md#manage-namespace-policy).
Groups and Restrictions remain managed by the selected IAM authority. See
[Authorization](../../reference/authorization.md) for available actions, scope,
and how denials work.

If a request returns `401`, check the session or service key. A `403` means the
current identity, scope, grant, or a Restriction did not permit the operation.
Have an administrator check the exact resource and action; access to a Namespace
does not give access to every resource in it.

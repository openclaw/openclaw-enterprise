---
rfc: index.md
---

# Scope credential sources to a TokenService instance

This proposed amendment replaces the per-source Driver identity and delivery decisions in the
[Installation credential ownership amendment](installation-credential-ownership.md). An Installation
selects one TokenService instance. Credential sources belong to that instance. Credential Proxy owns
how each bound source reaches its consumers.

## Source identity and replacement

OCC gives each TokenService instance a stable identity. It retains that identity across ordinary
restarts and redeployments, and allocates a different identity when the credential store is replaced.
OCC privately associates each source and Installation OAuth client registration with the instance
that registered it. A Driver type or reusable configuration name is not sufficient to identify the
credential store.

OCC refuses to replace an instance while it has registrations unless an explicit migration or reset
handles them. Replacement without migration starts a fresh credential domain. A reference from an
older instance must never resolve, update, or delete a credential through the replacement. A reset
cannot complete while old Agent bindings, pushed copies, or attached providers can still use the
retired registrations. Replacing the instance does not by itself copy or destroy material in the old
store. Migration and reset procedures are outside this amendment.

Public CredentialSource metadata describes the source, its Namespace, configuration, optional
Connection Template, lifecycle state, and any status or credential version the owner can report. It
does not expose the TokenService instance association, Driver ID, private backend reference, delivery
mode, or credential material. An attached Connection Template retains its identity and supplies its
current settings.

## Notify the proxy when a credential changes

After TokenService commits new authoritative material, it notifies the Credential Proxy of the
source reference and the credential version, when known. The notification contains no credential
material and does not select a delivery method. The API and worker use the same lifecycle boundary;
a scheduled refresh does not require an API request to notify the proxy.

The proxy owns delivery for its source binding. Multiple Agent bindings may share the proxy's
Namespace-and-source delivery resource, while retaining separate placeholders and injection policies.
The proxy uses only a source-bound, authorized TokenService operation to obtain a credential it must
deliver. A notification does not grant general access to Secrets or other sources.

- **Push:** An OCC-owned credential can be delivered through an embedded or standalone proxy. For
  example, an OpenShell proxy updates its OpenShell provider. If no delivery resource exists, the
  notification succeeds without resolving material or creating a resource. Otherwise, the proxy
  obtains the credential through the authorized source operation. The resolved credential must have a
  version even if the notification did not include one. The proxy updates the existing resource and
  acknowledges delivery only after every serving copy can use that version. An older update must not
  overwrite a newer delivered version, including when notifications overlap.
- **Managed by the same implementation:** When OpenShell implements both TokenService and Credential
  Proxy, the proxy attaches the existing provider after checking its backend and Workspace. OpenShell
  handles renewal internally. OCC need not observe or report every rotation, and no material transfer
  is required. This is an implementation-specific way to satisfy the binding, not a third delivery
  mode named `native`. Policy, readiness, and withdrawal checks still apply.
- **Pull (proposed):** A proxy can obtain an authorized credential when a bound consumer needs it.
  On an update notification it can invalidate its cache or take no action, according to its freshness
  contract. It must not resolve material merely to discard a push. The
  [Git credential pull discussion](git-credential-pull.md) retains the open first-request,
  recipient, grant, and cache questions. This amendment does not implement or qualify pull.

A failed delivery does not roll back the committed credential. OCC reports a sanitized delivery
failure separately from issuance or refresh status. An authorized administrator can request delivery
again. Automatic retries and recovery remain deferred. Accepting a notification is not evidence that
a push reached its serving copies.

## Contract and verification scope

Revise the proposed TokenService registration contract to retain the private registration locator
without a source-level delivery mode. Keep the instance association in OCC's internal registration
record. Revise the Credential Proxy deployment/update contract so the proxy receives the change
notification, selects delivery from its binding and supported implementation, and can obtain only the
authorized source it needs. Publish CredentialSource metadata without owner or delivery fields.
These contract changes do not switch the existing Secret-reference CRUD routes to TokenService.

Before release, exercise the regular Agent workflow with both supported ownership configurations:
register, bind, update or refresh, observe the proxy result, and withdraw. Verify refusal of instance
replacement with registrations, rejection of stale references, absence of private fields and material
from metadata and notifications, and retention of the new authoritative value after delivery failure.
For push, verify the expected version on every serving copy, an authorized manual retry, and that
concurrent updates cannot restore an older version. For a
shared OpenShell provider, verify attachment, readiness, and withdrawal without requiring OCC to
observe an internal token version. Pull needs its own submitted protocol and integration proof.

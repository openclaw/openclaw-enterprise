---
created: "2026-11-04"
updated: "2026-11-05"
last_updated_session: codex/01a1aad6-adec-7fa0-802a-50b5e0486319
---

# How OCC saves an OAuth connection template

## Overview

An Installation administrator defines where an account can connect and which OAuth client represents the Installation. A person then selects that template to connect an account in a Namespace. OCC runs the browser authorization flow. The Token Service stores and renews the grant. The person can finish connecting before choosing an Agent.

## Entry Points

- An Installation administrator opens **Credentials → Connection templates** to edit a template, or **OAuth clients** to register a client against a template version. `apps/controller/src/http/connection-templates.ts:connectionTemplateHandlers`
- A signed-in person with permission to create a credential in the destination Namespace starts consent with a template available there. The OAuth provider returns the browser to OCC's shared callback. `packages/occ/src/index.ts:startNamespaceConnection` and `packages/occ/src/index.ts:completeNamespaceConnection`

## Flow

### Template and client setup

When a user chooses **Connect and attach** in an Agent plugin slot, OCC checks
Agent update permission and asks the Plugin Driver whether the template fits
the selected release and slot. It records that target and the expected binding
in the private browser attempt. After saving the account, OCC rechecks the
Agent, release, slot and current permissions. It grants the Agent access and
saves the Driver's updated selection in one transaction. If the attachment
fails, the account remains available for the user to attach later.

A detach removes that Agent's grant and queues withdrawal for its deployed
revisions. Until the worker finishes, the running revision can retain access.
The same account can continue serving other authorized Agents.

The callback consumes the attempt once. OCC verifies the signed-in account and session after any database wait and before code exchange. It checks the session again before storing the grant or granting its owner access.

OCC checks the caller's right to create a credential in the destination
Namespace and pins the selected template version. It creates a pending source
and saves the PKCE verifier in a private database row bound to that browser
session and principal. The callback consumes the attempt once, rechecks
authorization, and reads the client registration and exchange URL from the
pinned version.

The Credential Refresh Driver exchanges the code using the pinned client and
its registered authentication method. For an MCP connection it sends the
approved resource at authorization, exchange, and refresh. The Token Service
keeps the access token and refresh grant in a private Secret. OCC records the
credential source ID, account owner, approved recipient, requested scopes, and
granted scopes. When the person requests provider defaults, the Driver omits the scope parameter. It records the scopes the provider reports, or an empty list if the provider omits them. Renewal can narrow the recorded grant. It cannot add scopes to an unreported grant. A shared callback verifies the issuer when multiple issuers are
configured. A provider timeout consumes the attempt.

OCC saves the consent receipt under its original immutable template version. When listing an account, `PlatformController.effectiveConnectionDestinations` reads the current version of that same template. For manual accounts, it returns the current destinations when the issuer and manual mode still match. For MCP accounts, it returns the original destinations only when issuer, discovery mode, exact server URL and protected resource still match. A missing or incompatible template returns an empty list. This projection does not rewrite the saved registration, grant, token endpoint or consent audit. For MCP, the Driver sends the original resource identifier to the provider.

The worker renews the saved account through the Token Service. For each refresh, it checks the saved grant against the approved registration
and resolves the current client secret from its Driver. A conditional write
fences concurrent renewals and disconnects. OCC records the next renewal
and any narrower scopes. Creating and renewing a saved account require no
Agent or sender profile.

## Bind a saved account to a plugin

The Plugin Driver identifies the named accounts in the selected release. OCC lists ready accounts the caller can operate in the Namespace whose issuer the slot accepts. It marks an account for new authorization when the approved protected resource or destination differs. A grant's scopes are available to the provider and the request policy.

Saving a selection checks the exact slot, account and Agent permissions together. Starting OAuth from a saved slot also records the release and current binding. When the browser returns, OCC checks both before replacing that slot. The account stays with its owner if the binding changed during consent.

Admission records the saved account and its sender for this Agent. The worker resolves the account’s template again when it prepares a revision and during maintenance. For manual OAuth it reads the latest destinations from the same issuer. For MCP it checks the original server and resource. Console tool discovery makes the same check before it sends a credential.

When a sender’s host, port or path changes, the Credential Gateway clears the bearer and waits for OpenShell to acknowledge withdrawal on the receiving Sandbox. The Sandbox Driver applies the updated network policy and checks its effective request guard. Compute then asks OCC to release the access token. OCC rechecks the Agent grant and the expected policy before publishing. An update that fails retries without releasing credentials to the new destination. Detaching queues withdrawal for the affected Agent. Other Agents retain their own sender.

If a template changes to an incompatible recipient or allows no operation the account can perform, OCC withdraws that account’s token. The running Sandbox keeps the empty provider in its launch configuration. The worker can deliver tokens for the Agent’s other slots. If a later edit restores a usable destination, delivery can resume with the same saved account.

For a saved Google account, the Credential Gateway configures one OpenShell provider. It includes a host, port and path only when the current template and a reviewed Google Workspace operation both allow it, and the account has the scope for that operation. The Sandbox Driver checks those routes and the Installation’s approved executables. Each executable uses the same request guard.

An Agent network grant and a template edit can both change the running Sandbox policy. The Sandbox Driver reads the current policy before applying either change. A template edit preserves the Agent’s network grants. Applying a grant preserves the account’s current request guard. If the changes overlap in a way that would bypass the guard, the Driver refuses the update.

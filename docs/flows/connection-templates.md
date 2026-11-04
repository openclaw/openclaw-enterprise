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

See [OAuth connection templates](../reference/connection-templates.md) for the
administrative operations.

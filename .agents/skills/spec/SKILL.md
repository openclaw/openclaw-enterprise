---
name: spec
description: Draft or update OpenClaw Enterprise RFCs and implementation plans with
  repository numbering and lifecycle rules.
dependencies:
  - enterprise-testing
  - technical-writing
---

# Spec

Use the user's requested mode. If a request only asks to evaluate an idea or
process, discuss it without creating or moving documents.

- `rfc <description>`: propose an architectural decision. Read
  [the RFC workflow](./references/rfc.md) and use the shared
  [RFC template](../../../docs/contributing/rfc-template.md).
- `plan [RFC-ID or path] <description>`: plan implementation of an RFC or
  independent feature. Read [the plan workflow](./references/plan.md); its
  scaffold is [the plan template](./assets/plan-template.md).

These commands author documents. They do not by themselves authorize product
implementation, acceptance, publication, or archive reorganization. Preserve
any broader authorization already given in the conversation.

Paths in the workflows are relative to the repository root unless explicitly
identified as bundled skill paths. The repository's specification process owns
numbering, placement, status, and historical exceptions; read it before writing.
Use $technical-writing for prose and $enterprise-testing for proportional
verification requirements. Neither requires a global skill installation.

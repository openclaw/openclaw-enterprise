# Security Policy

## Report privately

Email [security@openclaw.ai](mailto:security@openclaw.ai) and identify the affected
project as **OpenClaw Enterprise**. This is the existing
[OpenClaw security contact](https://github.com/openclaw/openclaw/security/policy#report-a-security-issue)
for routing reports. Do not open an ordinary issue or PR with an unpatched
vulnerability, exploit, tenant data, or credential, even in this private repository.
Coordinate reproduction material and any patch through the security team.

Include:

- The affected commit or version, component, and deployment mode.
- The caller's initial identity, permissions, and resource scope.
- Minimal reproduction steps using synthetic data and systems you are
  authorized to test.
- Expected and observed behavior, the crossed boundary, and demonstrated impact.
- Redacted evidence and any proposed remediation.

Do not send live credentials or customer data. If sensitive evidence is necessary,
ask the security team how to transfer it. Scanner results are useful leads;
include a reproduction when available and distinguish confirmed impact from a
hypothesis. Do not delay a report of suspected exposure to complete a patch.

## Enterprise security boundaries

OpenClaw Enterprise is a control plane with explicit tenant and IAM boundaries.
Do not apply the core gateway's single-operator trust assumptions to the
Enterprise controller API.

- **Authentication and authorization:** A human session or service API key
  establishes an identity, not unrestricted access. The selected IAM Driver
  checks current policy for the exact action, resource, and Namespace. Report
  authentication bypasses, permission escalation, and failures to enforce
  revocation or Restrictions.
- **Tenant and resource isolation:** Access to one Namespace, Agent, revision, or
  service account must not grant access to another outside the caller's explicit
  authority. Cross-tenant disclosure, mutation, execution, and incorrect workload
  routing are security-relevant.
- **Credentials:** Service keys, bootstrap output, provider credentials, and
  runtime Secrets have distinct owners and delivery paths. Report unauthorized
  issuance, access, delivery, or disclosure through responses, logs, audit,
  revisions, or workload configuration.
- **Deployment and execution:** Production workload identity, approved immutable
  images, admission controls, and network isolation are part of the documented
  deployment boundary. A Driver configuration or rendered manifest alone is not
  proof that a cluster enforces those controls.
- **Audit:** Bootstrap, mutations, authorization denials, and lifecycle outcomes
  have attributable evidence. Report ways to bypass or falsify required audit
  behavior without the relevant authority.

Authoritative behavior and current limitations are documented in
[authentication](docs/reference/authentication.md),
[authorization](docs/reference/authorization.md),
[credential ownership](docs/reference/service-accounts.md),
[Secret delivery](docs/flows/secret-storage-and-delivery.md), and
[security controls](docs/reference/security.md).

The local Docker development stack gives its worker Docker host access; it is
not a production tenant-isolation boundary. Production also retains documented
limits around worker namespace authority, runtime credential possession, model
egress, and transport authentication. Report against the actual supported mode
and identify any violated guarantee; these limitations do not exclude unrelated
Enterprise authorization or tenant-isolation defects.

## Verification and disclosure

Use isolated resources and obtain authorization before testing a live
installation. Never probe another tenant or production system merely because
you can reach it. Follow [Testing](docs/testing/README.md) and distinguish local,
fixture, real-cluster, and model-backed evidence.

Coordinate disclosure with the security team. This policy does not create a
bug bounty, response-time guarantee, or security certification.

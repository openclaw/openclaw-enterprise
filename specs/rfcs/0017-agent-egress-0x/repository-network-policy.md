---
rfc: index.md
---

# Per-Agent repository network policy

## Problem

An Agent may need to fetch from one repository and push to another on the same HTTPS origin. The [Sandbox network grant](../../../packages/contracts/src/sandbox-policy.ts#L7-L37) selects an executable, host and port ranges. It cannot express which repository the Agent may access or which HTTP method it may use, so a host grant cannot distinguish those operations.

The [prepared Git Provider profile](../../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts#L228-L254) requires a bearer installation token and, for an installation scope, allows `GET /**/info/refs`, `POST /**/git-upload-pack` and `POST /**/git-receive-pack`. Those rules cover Git transport paths across repositories. Credential permissions can limit what the Git service accepts, but they do not demonstrate that the Sandbox independently enforces repository-specific read and write access at the network boundary.

## Decision

Amend [RFC-0017](index.md) with a narrow repository ACL contract for supported Sandbox Drivers. An authorized Admin configures read or write access to canonical repositories for an Agent, within the Installation’s existing delegation limits. A deployed revision binds the validated ACL and its effective network policy immutably. Read permits clone and fetch; write includes read and permits push. Ungranted repositories are denied.

This amendment defines network authorization. It does not change credential delivery, issue credentials, or require a new credential service. The Agent receives no real credential. Configuration contribution ownership remains governed by [RFC-0022](../0022-driver-configuration-contributions.md).

## Configuration and Driver contract

- **Configuration and IAM:** expose an explicit repository ACL through the authorized Agent configuration interface. Check the caller’s Agent-configuration authority and the applicable Installation delegation limits. Reject malformed, ambiguous, or excessive grants; never silently expand or downgrade them.
- **Persistence and revision:** validate and persist the typed ACL without losing its repository or access identity. Admission resolves it into an immutable deployed revision. Later edits require a new revision; an existing deployment continues using its admitted policy.
- **Capability:** a Sandbox Driver must explicitly qualify repository ACL support. A Driver that cannot preserve the requested semantics refuses admission or deployment with an actionable unsupported-policy result. The Driver owns backend-specific rendering and enforcement.
- **Composition:** retain existing protected-execution and bypass protections. Repository ACLs are distinct from ordinary host grants. Their effective policy uses inspected HTTPS, additive `ENFORCE`, and default deny; another contribution must not broaden repository access or bypass inspection. Refuse conflicting policy that cannot meet these requirements. Keep the current checks that the attached proxy plan matches the admitted revision and that the protected Harness credential source matches its admitted source.
- **Readback:** expose the admitted revision, canonical repository permissions, Driver capability, and effective inspection/enforcement state. A requested configuration is not evidence that the network effect was installed.

## Network effect and refusals

For native Git over HTTPS, discovery is `GET .../info/refs` with the appropriate `service` query: `git-upload-pack` for reads and `git-receive-pack` for writes. The corresponding RPC is POST to `.../git-upload-pack` or `.../git-receive-pack`. Bind method, canonical repository path, and service together. Read access must deny receive-pack discovery and direct RPC before the origin; no grant must deny both services before the origin. Malformed paths and direct/raw, alias, IP, redirect, or alternate routes must not bypass this boundary. Redirects must not transfer authorization to a different repository or endpoint.

The stock matcher can accept HEAD where GET is allowed, identical duplicate service values, and extra query keys. Test those forms and conflicting duplicates against the actual installed policy and origin. An accepted form must not enable A push, C access, forbidden origin forwarding, or credential exposure; any bypass blocks qualification. Document accepted forms rather than claiming they were rejected. Exact rejection of all such syntax is separate hardening and may require a compatible matcher extension.

## Acceptance criteria

Use a protected synthetic or disposable fixture whose origin-side control credential is independently confirmed to permit pushing A and reading C. On one immutable revision granting A read and B write, prove:

1. Clone/fetch A and B succeed.
2. Push discovery and direct receive-pack for A are refused before origin.
3. Push B succeeds and the remote ref matches the pushed commit.
4. Discovery and direct RPC for ungranted C are refused before origin.
5. Adversarial method/query and alternate-route cases cannot bypass the admitted ACL or expose credentials; record accepted forms and refusal/origin observations, and match complete effective policy readback to the revision.
6. A changed attached proxy plan or protected Harness credential source still refuses provisioning; existing session and issuer controls remain enforced.

Installed qualification requires observations from the actual supported Sandbox and origin. Source or protocol tests alone are insufficient.

## Alternatives and scope

Credential-only restrictions do not establish an independent network boundary. Host-only grants cannot distinguish repositories. Unqualified ordinary network additions can weaken inspection or protected execution. Broad API access is outside this change: Issues reads and bounded REST pull-request operations can be specified separately; opaque GraphQL is denied unless authorization binds the request body and repository.

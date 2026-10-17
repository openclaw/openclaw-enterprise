# Inspect and simulate Agent policies

Open a deployed Agent version's **Policy tester** tab. You can also select
**Inspect / test action** on a Sandbox decision in **Logs**. The tester supports
network requests and plugin tool actions independently of log access.

## Simulate authored OCE policy

Select an action kind and review the OCE policy snapshot. Plugin selections come
from the immutable revision. Sandbox intent comes from the current selected
Driver configuration; Agent versions do not freeze that configuration.

For a network action, enter the host, port and full executable path. Optional
ancestor paths and HTTP method/path refine the hypothetical action. A logged
executable name does not verify its full path.

For a plugin action, select its plugin and tool. Optional read-only/destructive
annotations describe hypothetical action metadata; they do not establish native
runtime annotations.

Select **Simulate policy** to see the OCE decision, rule reasons and checks outside
coverage. Decisions include allow, deny, audit, approval required and unknown.
Plugin disablement takes precedence over tool overrides; an explicit tool
setting precedes its default. Native approval defaults and unverifiable tool
ownership remain unknown. A required approval does not predict a reviewer's answer.

Network simulation covers exact and simple `*`/`**` host and executable selectors,
ancestor identity, default deny, and REST method access presets. Richer selectors,
unmodeled HTTP normalization, and unsupported conditions remain explicit.
Changing policy rejects a stale simulation hash; editing inputs clears results.

## Inspect native policy separately

For network actions, **Inspect native policy** reads the provider's effective
rules, hash and admission. Applied means a Ready Sandbox admitted that exact
snapshot. Native **Evaluate policy** uses the provider's own evaluator. Provider
and global rules can make its result differ from authored OCE intent.

The bundled OpenShell pin supports inspection but lacks the new evaluation RPC.
That limits native evaluation; OCE simulation remains available. Neither operation
sends the entered action to its destination. Observed log decisions remain
historical evidence and are not automatically replayed.

## Access and verification

Inspection and simulation require Agent `operate` and `read`, plus `read` on the
selected version. Reads are audited before Driver access, without recording
entered actions. Log permissions are separate.

Driver conformance compares independently expected actions against actual
translated policies. Native evaluator checks and real runtime tests have distinct
proof limits; an OCE simulation alone does not establish connectivity, installation,
process identity, credentials, or deployed enforcement.

- [Sandbox Driver](../../reference/drivers/sandbox.md)
- [Plugin Driver](../../reference/drivers/plugin.md)
- [Execution flow](../../flows/agent-network-policy.md)

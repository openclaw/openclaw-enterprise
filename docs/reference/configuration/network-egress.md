# Agent network egress modes

Set top-level `networkEgressMode: public` or `networkEgressMode: restricted`
in the Installation file read by both API and worker. The
[protected Kubernetes setup](../../guides/deploy/kubernetes-setup.md) and new
Kubernetes development installations select `public`. Ordinary installation
profiles select `restricted`. Omission means `restricted`; changing a
startup file does not change an admitted Agent revision. Deploy a successor to
use the new choice. The full Agent revision response records its selected mode.

`public` selects the Driver's public TCP mode. OpenShell's public fallback uses
its policy DNS resolver for unclaimed hostnames that resolve to public IPv4
addresses, on any TCP port. It adds no fallback for raw IP targets or explicit
proxy commands. It grants no general IPv6 or UDP access. Code in the Agent can
send workspace data to public services. Credential custody, managed destination
authorization, and private control-plane routes remain separate boundaries.
Both the selected Compute Driver and any Sandbox Driver must support this mode;
admission refuses unsupported Drivers with a corrective error.

Public mode also requires external model credential custody. Direct `api_key`
and `codex_pat` Harness authentication is refused before deployment. Use a ready
CredentialSource with the paired Credential Gateway and Sandbox through the
[first-Agent workflow](../../guides/deploy/deploy-first-agent.md). The bundled
supported authenticated path uses dedicated execution; channel credentials stay
in its separate Gateway. Embedded public workloads cannot receive Configuration
Secret bindings. These checks govern platform credential delivery, not secret
values an operator or Agent independently writes into a workspace.

| Driver path                 | `public`                                                                                                                          | `restricted`                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Ordinary Kubernetes Harness | Unsupported; select a supporting Sandbox and Credential Gateway.                                                                  | Existing model egress on TCP/443 plus explicit platform routes. This is not a hostname allowlist. |
| OpenShell Harness           | Mediated public TCP fallback for unclaimed DNS destinations. Managed hosts retain their policies across ports, including denials. | Declared Sandbox and managed provider routes; no public fallback.                                 |

OpenShell requires a gateway and supervisor that support the mediated fallback
and report the applied mode. Stock v0.1.6 does not support public mode. Do not use
raw allow-all mode to bypass this requirement. See
[Kubernetes network boundaries](../drivers/kubernetes-compute/networking-and-isolation.md)
and [OpenShell configuration](../drivers/openshell-sandbox.md#configuration).

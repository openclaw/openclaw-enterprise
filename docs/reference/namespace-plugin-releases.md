# Namespace plugin releases

A Namespace or Installation administrator with `namespace:publish_plugins` can import and publish packages for dedicated OpenClaw Agents on Kubernetes. OCC inspects the archive, retains the reviewed content and gives the release an immutable digest. A release belongs to one Namespace. To select a release, save the draft or deploy it, Agent owners need `namespace:read` in that Namespace as well as the usual Agent permissions. See [Import a plugin](../guides/topics/plugins-configure.md#import-a-plugin-for-a-dedicated-openclaw-agent).

## Package contents

Each API replica allows a principal to make 20 preview or publication requests in a burst. The two operations share a budget that replenishes by one request every three seconds. If a request returns HTTP 429, wait for the interval in `Retry-After` before retrying.

| Declaration                                                             | Dedicated OpenClaw behavior                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Plugins package or Claude plugin directory                        | Reads the manifest and previews the effective skills, hosted servers and excluded components.                                                                                                               |
| Marketplace archive                                                     | Imports the named entry when the archive includes its source directory. Supply the resolved package separately for a remote entry.                                                                          |
| Skill directory                                                         | Retains `SKILL.md`, supporting files and executable modes. The Gateway loads read-only files from the deployed revision and sends them to the worker. A same-name workspace substitution prevents delivery. |
| Fixed HTTPS Streamable HTTP MCP server                                  | Publication offers a Namespace connection template for that server. Agent owners can enable selected tools or leave the server off.                                                                         |
| Hooks, commands, provider-specific agents and local MCP launch commands | Shows excluded declarations in the preview. The import process never runs package code.                                                                                                                     |

For an Agent Plugins package, the preview lists each skill with invalid metadata and each invalid MCP server as an exclusion. If the optional `mcp.json` is unreadable, the preview excludes that descriptor. You can publish the remaining skills and servers. The API rejects publication if none remain. Unsafe archive paths and package size limits apply to the whole upload, including excluded components.

## Connections and deployment

For a published MCP server, open **Configure plugins** on the Agent and choose **Create connection**. The bearer connection template identifies the release digest, server name and fixed destination. To create the CredentialSource, you need `namespace:read` on the release’s Namespace, `credential_source:create` there and `secret:operate` on the token Secret. OCC reads the endpoint from the release and rejects destination overrides.

Attach the source to the Agent, select the tools, save the draft and deploy. The dedicated OpenShell proxy injects the bearer token at the admitted endpoint and checks each tool name. Installations using the execution-scoped Credential Proxy Driver require its future MCP support.

Binding a saved OAuth account to an imported server is pending in the shared Agent grant workflow. For account setup, see [OAuth connection templates](connection-templates.md).

The Agent revision pins the immutable release digest. OCC rejects selections whose imported skill files together exceed 8 MiB when you save or deploy. The running revision continues serving. Publishing another release does not upgrade a running Agent. Removing a selection and deploying removes that version's skill and server. An old connection can stay attached to the Agent. The next worker receives it only if the deployed revision selects the matching release, server, and at least one tool. For revocation on a running Agent, see [withdraw a credential source](credential-sources/withdrawal.md).

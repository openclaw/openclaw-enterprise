# Namespace plugin releases

A Namespace or Installation administrator with `namespace:publish_plugins` can import and publish packages for dedicated OpenClaw Agents on Kubernetes. OCC inspects the archive, retains the reviewed content and gives the release an immutable digest. A release belongs to one Namespace. Agent owners can deploy it there with the usual Agent permissions. See [Import a plugin](../guides/topics/plugins-configure.md#import-a-plugin-for-a-dedicated-openclaw-agent).

## Package contents

| Declaration                                                             | Dedicated OpenClaw behavior                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Plugins package or Claude plugin directory                        | Reads the manifest and previews the effective skills, hosted servers and excluded components.                                                                                                               |
| Marketplace archive                                                     | Imports the named entry when the archive includes its source directory. Supply the resolved package separately for a remote entry.                                                                          |
| Skill directory                                                         | Retains `SKILL.md`, supporting files and executable modes. The Gateway loads read-only files from the deployed revision and sends them to the worker. A same-name workspace substitution prevents delivery. |
| Fixed HTTPS Streamable HTTP MCP server                                  | Publication offers a Namespace connection template for that server. Agent owners can enable selected tools or leave the server off.                                                                         |
| Hooks, commands, provider-specific agents and local MCP launch commands | Shows excluded declarations in the preview. The import process never runs package code.                                                                                                                     |

## Connections and deployment

A template identifies the published digest, server name and destination. Creating a bearer CredentialSource requires authority to create the source and use its token Secret. OCC reads the endpoint from the release. An explicit destination override is refused. The Agent owner must separately attach the source, select the tools, save the draft and deploy. The dedicated OpenShell proxy injects the token at the admitted endpoint, and its request policy checks the tool name. Installations using the separate execution-scoped Credential Proxy Driver require its future MCP support.

The Agent revision pins the release and its files. Publishing another release does not upgrade a running Agent. Removing a selection and deploying removes that version's skill and server. For revocation on a running Agent, see [withdraw a credential source](credential-sources/withdrawal.md).

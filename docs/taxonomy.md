# Documentation taxonomy

## Overview

Use `kind` in a page's YAML frontmatter to identify its document type and
select its template. A kind describes the content. The site menu and file
location follow the reader's task and the [repository layout](layout.md#documentation-placement).

| Kind               | Applies to                                                   | Template                                                                          | Example                                                |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `reference/driver` | The shared interface and lifecycle for one Driver capability | [Driver contract](../.agents/skills/technical-writing/assets/reference-driver.md) | [SandboxDriver contract](reference/drivers/sandbox.md) |

Copy the template, including its frontmatter, when you write a base Driver
contract. An implementation page such as [OpenShell SandboxDriver](reference/drivers/openshell-sandbox.md)
describes a specific provider and does not use this kind.

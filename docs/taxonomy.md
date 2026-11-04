# Documentation taxonomy

## Overview

Use `kind` in a page's YAML frontmatter to identify its document type and
select its template. A kind describes the content. The site menu and file
location follow the reader's task and the [repository layout](layout.md#documentation-placement).

| Kind                    | Applies to                                                                    | Template                                                                                     | Example                                                |
| ----------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `reference/driver`      | The shared interface and lifecycle for one Driver capability                  | [Driver contract](../.agents/skills/technical-writing/assets/reference-driver.md)            | [SandboxDriver contract](reference/drivers/sandbox.md) |
| `reference/driver/impl` | One Driver implementation's provisioning, configuration, and operating limits | [Driver implementation](../.agents/skills/technical-writing/assets/reference-driver-impl.md) | OpenShell or Kubernetes implementation reference       |

Copy the selected template, including its frontmatter, when you write a new page.
Use `reference/driver` for the shared capability contract and
`reference/driver/impl` for a specific implementation. Add new kinds and template
links here and in the technical-writing skill's mapping table in the same change.

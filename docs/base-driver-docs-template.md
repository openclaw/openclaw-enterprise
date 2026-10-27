# Base Driver documentation template

When writing or rewriting a base Driver contract, use the repository-owned
[Driver contract Markdown template](../.agents/skills/technical-writing/assets/reference-driver.md).
It starts with `kind: reference/driver`. See the [documentation taxonomy](taxonomy.md)
for the scope of this kind.

The required sections are **Overview**, **Interface**, **IAM**, **Lifecycle**,
**Limits**, **Troubleshooting**, **Implementations**, and **Related**. Interface
lists properties first and methods second. Each table lists required members
before optional members and names any mode that requires an optional member.
IAM describes authorization,
identity scope, and credential boundaries. Lifecycle distinguishes the Driver
instance from the resources it manages.

Start with [Driver development](contributing/driver-development.md) to find
the existing base contract. Base contracts belong in
`docs/reference/drivers/<capability>.md`; backend configuration, setup commands,
and backend-specific troubleshooting remain in implementation references.
See the [ComputeDriver contract](reference/drivers/compute.md) for an applied
example.

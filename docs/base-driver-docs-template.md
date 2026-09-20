# Base Driver documentation template

When writing or rewriting a base Driver contract, use the repository-owned
[technical-writing template](../.agents/skills/technical-writing/references/driver-contracts.md).
It is the canonical template used by the local technical-writing skill.

The required sections are **Overview**, **Interface**, **IAM**, **Lifecycle**,
**Limits**, **Troubleshooting**, **Implementations**, and **Related**. Interface
separates core operations from optional additions. IAM describes authorization,
identity scope, and credential boundaries. Lifecycle distinguishes the Driver
instance from the resources it manages.

Start with the [Driver documentation inventory](driver-docs-inventory.md) to find
the existing owner. Base contracts belong in
`docs/reference/drivers/<capability>.md`; backend configuration, setup commands,
and backend-specific troubleshooting remain in implementation references.
See the [ComputeDriver contract](reference/drivers/compute.md) for an applied
example.

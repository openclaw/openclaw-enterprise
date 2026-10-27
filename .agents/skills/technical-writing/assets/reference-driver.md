---
kind: reference/driver
---

# [Driver name] contract

## Overview

[Name the caller, the capability this Driver owns, and the result it produces.
State which configurations support it and which responsibilities belong to an adjacent Driver.]

## Interface

[Link the exported interface and its callers. Include required properties as
well as methods. For optional members, name any modes that require them and
what the caller does when they are absent.]

| Member                 | Requirement         | Caller and behavior                                |
| ---------------------- | ------------------- | -------------------------------------------------- |
| `<required member>`    | Required            | [Inputs or property value, result, and effect.]    |
| `<optional method>`    | Optional            | [Who calls it, when, and what happens if omitted.] |
| `<conditional method>` | Required for [mode] | [Prerequisite, result, and failure when absent.]   |

[Remove example rows that do not apply. Add Interface subsections for facets,
input types, or optional operations when these need more detail.]

## IAM

[Identify the acting identity, who authorizes the operation, the exact resource
scope, and the result of a denial. Explain which credentials or references cross
the Driver boundary.]

## Lifecycle

[Trace one supported operation from selection or admission to its final result
and cleanup. Name the caller and owner at each handoff. Include the checks
before activation, the effect of a failure, and who retries. Distinguish Driver
instance lifetime from the lifetime of resources it manages.]

## Limits

[State supported combinations, enforced limits, and behavior outside those limits.]

## Troubleshooting

| Symptom              | Check                                      | Recovery and expected result      |
| -------------------- | ------------------------------------------ | --------------------------------- |
| [Observable failure] | [First check that distinguishes the cause] | [Action and evidence of recovery] |

## Implementations

- [Link each supported implementation and state its selection or support limits.]

## Related

- [Link the owning feature, adjacent contracts, runtime flow, or verification guide.]

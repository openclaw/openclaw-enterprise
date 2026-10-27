---
kind: reference/driver
---

# [Driver name] contract

## Overview

[Name the caller, the capability this Driver owns, and the result it produces.
State which configurations support it and which responsibilities belong to an adjacent Driver.]

## Interface

[Link the exported interface and its callers. In each table, list required
members first, then optional members. Use only `Required` or `Optional` in the Requirement
column, as declared by the exported type. For optional members, describe the
default, fallback, or unavailable feature in the value or behavior column.]

### Properties

| Property              | Requirement | Value and meaning                           |
| --------------------- | ----------- | ------------------------------------------- |
| `<required property>` | Required    | [Value and what it identifies or declares.] |
| `<optional property>` | Optional    | [Meaning and default when omitted.]         |

### Methods

| Method              | Requirement | Caller and behavior                                     |
| ------------------- | ----------- | ------------------------------------------------------- |
| `<required method>` | Required    | [Caller, inputs, result, and effect.]                   |
| `<optional method>` | Optional    | [When the caller needs it and what happens if omitted.] |

[Omit empty groups. Add Interface subsections for facets, input types, or
operations that need more detail.]

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

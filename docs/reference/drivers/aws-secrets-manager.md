---
kind: reference/driver/impl
---

# AWS Secrets Manager Secret Driver

**Contents**

- [Overview](#overview)
- [Lifecycle](#lifecycle)
- [Configuration](#configuration)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)

## Overview

Select this [Secret Driver](secret.md) to store Namespace Secrets in AWS and read them in trusted controller operations. For example, saved-Agent hosted plugin discovery uses the Agent's bound Secret after OCC checks the caller's and Agent's grants. Protected static sources can read the AWS version with the value.

## Lifecycle

OCC generates the Secret ID. The Driver derives a stable UUID and creation token from it and uses the name `<prefix>/<namespaceId>/<secretId>/<uuid>`. It verifies the workload account with STS before sending the value. STS and `CreateSecret` use the same captured credentials. The Driver verifies the returned identity, then calls `DescribeSecret` to check ownership and the current version before OCC saves metadata.

The backend reference contains the UUID, encoded AWS suffix and SHA-256 digest of the complete ARN split across DNS labels. Subsequent operations reconstruct that ARN, verify its digest and check the four ownership tags. A change of account, region, prefix, Namespace, Driver or Secret identity prevents access.

- Reads request both the observed version ID and `AWSCURRENT`, then check ownership and the current version again. The Driver caches no values. A rotation after the last check can affect the next read.
- Updates use `PutSecretValue` to move `AWSCURRENT`. A separate observed `AWSPENDING` version blocks the update. Concurrent updates are last-writer-wins. AWS limits version creation frequency. See [PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html).
- Deletion requests a 30-day recovery window. A retry succeeds if the same owned Secret already has a deletion date. A missing object requires operator reconciliation. Restoring it in AWS does not recreate OCC metadata.

## Configuration

In trusted Installation YAML, select the reserved Driver ID:

```yaml
drivers:
  secret:
    id: secret-aws-secrets-manager
    configuration:
      region: us-east-1
      accountId: "123456789012"
      prefix: oce/production
```

| Setting     | Type   | Requirement | Value                                                                                                                                                              |
| ----------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `region`    | string | Required    | AWS region for STS and Secrets Manager.                                                                                                                            |
| `accountId` | string | Required    | Twelve-digit AWS account that owns the Secrets.                                                                                                                    |
| `prefix`    | string | Required    | Up to 200 letters, digits, underscores, hyphens or slashes. The first character cannot be a slash.                                                                 |
| `kmsKeyId`  | string | Optional    | AWS KMS key identifier. Omit to use the AWS managed key. A customer-managed key requires key policy access and grants for `kms:GenerateDataKey` and `kms:Decrypt`. |

Provision the workload role and optional key separately. The Driver uses the AWS SDK default credential chain. Keep credentials out of Installation YAML. The Driver pins the regional HTTPS service endpoints and enables certificate verification. Node's CA trust and SDK credential-provider configuration are trusted operator inputs.

### Workload IAM policy

Scope the controller role to the selected account, region and prefix. Tagged creation requires both `secretsmanager:CreateSecret` and `secretsmanager:TagResource`. Constrain request tags and allowed tag keys. Prevent untrusted principals from replacing Secrets or changing ownership tags. A grant to tag a resource can also authorize later tagging. [AWS CreateSecret permissions](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html)

For existing Secrets, grant `DescribeSecret`, `GetSecretValue`, `PutSecretValue` and `DeleteSecret` only when **that ARN** matches its expected owners. For a fixed inventory, use one Allow statement per complete ARN. Require all four `StringEquals` conditions in each statement:

| Condition key                         | Required value for this ARN    |
| ------------------------------------- | ------------------------------ |
| `aws:ResourceTag/openclaw:managed-by` | `openclaw-enterprise`          |
| `aws:ResourceTag/openclaw:driver`     | `secret-aws-secrets-manager`   |
| `aws:ResourceTag/openclaw:namespace`  | This Secret's OCC Namespace ID |
| `aws:ResourceTag/openclaw:secret`     | This Secret's OCC Secret ID    |

Combining several ARNs and several acceptable Namespace tags in one statement loses the pairing. AWS must evaluate the tags for the value read, overwrite and deletion themselves because ownership can change after the Driver's metadata check. Review all applicable identity and resource policies for broader grants. [Secrets Manager actions and conditions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html)

The fixed-inventory policy covers existing ARNs. AWS assigns the ARN suffix at creation, and OCC immediately verifies the new object. Before enabling creates, qualify a policy that authorizes tagged creation **and the immediate ownership-bound Describe** for newly allocated identities. Waiting to grant access after OCC returns metadata leaves creation unable to finish.

## Limits

The AWS Driver supports server-side reads. Kubernetes Compute requires tenant-local Kubernetes Secret references for environment and Harness projections. SSH does not deliver AWS references either. Use Kubernetes Secret storage for these projections. Workflows that require atomic compare-and-swap, including device login, cannot use this Driver. External rotation is visible on subsequent successful reads. The Driver does not provision rotation functions.

## Troubleshooting

A provider or STS failure before submission prevents the write. Each Driver request has a 30-second ceiling and SDK retries are disabled. HTTP Secret writes share the handler's 12-second backend budget across credential lookup, STS and Secrets Manager. Protected reads also observe the caller's cancellation and deadline.

A timeout or failed verification after submission can leave a write applied. OCC returns a generic storage failure. Inspect AWS audit records and the owned resource before retrying. An OCC create retry with a new HTTP request generates a new Secret ID. Repeating a Driver create for the same ID uses the same name and token. The Driver never adopts a Secret by name, automatically deletes an uncertain create, or force-deletes a Secret.

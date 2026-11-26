# Credential Proxy request capacity

Set `requestCapacity` beside the Driver's `id` and `configuration`. Operations
and strict exchange IDs are per API process. Online-model ID quotas are shared:

```yaml
drivers:
  credential_proxy:
    id: openshell-egress
    configuration: # unchanged: the selected Driver's own settings
    requestCapacity:
      operations: 1024
      authenticatingOperations: 256
      sandboxOperations: 256
      requestIds: 8192
      sandboxRequestIds: 2048
```

| Field                      | Bound                                 | Default                   | Maximum | Released                                                                                                         |
| -------------------------- | ------------------------------------- | ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `operations`               | Operations in progress, all Sandboxes | 1024                      | 8192    | When the handle closes or expires and no authentication, installation, policy, Secret or receipt work is pending |
| `authenticatingOperations` | Operations still authenticating       | A quarter of `operations` | 8192    | When peer verification settles; a verified request moves to its Sandbox's share                                  |
| `sandboxOperations`        | Operations in progress, per Sandbox   | A quarter of `operations` | 8192    | When the handle closes or expires and no installation, policy, Secret or receipt work is pending                 |
| `requestIds`               | Request IDs, all Sandboxes            | 8192                      | 131072  | Strict: UUIDv7 creation + 30 s; online model: authenticated replay horizon                                       |
| `sandboxRequestIds`        | Request IDs, per Sandbox              | A quarter of `requestIds` | 131072  | Same                                                                                                             |

Each value is an integer from 1 to its maximum. Omitted shares default to a
quarter of their pool, rounded down to at least 1. Oversized shares and unknown
fields fail startup and upgrade checks with `DRIVER_CONFIGURATION_INVALID`.
Strict dispatch accepts 1 MiB. Online model authorization accepts 4 MiB per
request and retains at most 64 MiB of captured bodies per API process across
concurrent authorizations. Capacity returns when each authorization settles.
Transport buffers and parsing use additional memory. Restart API Pods after
capacity changes.

An operation slot covers the handle until closure or deadline (at most 30 s)
and any pending work until settlement. Verified sender and Sandbox identities
determine each Sandbox share. Authentication uses the global budget before
verification. Incomplete HTTPS grants have 32 listener slots and a five-second
deadline. gRPC verification and complete grants share the authentication lease.
A canceled final Secret read releases policy locks and retains capacity until settlement.

Online reservations retain recipient/request IDs until the authenticated replay
horizon, even after revision deletion. Database time governs admission,
retention and redemption. Quota contention retries within the original deadline
after releasing policy locks. A reservation becomes redeemable only after the
transport accepts the decision and OCC commits the approval.
Strict ID maps and operation caps remain per process.

Strict defaults allow about 270 requests/s per process and 68 per Sandbox
(`requestIds / 30` and `sandboxRequestIds / 30`). Captured IDs stay reserved after
refusal. With default shares, four busy Sandboxes can exhaust the pool.
Strict `resolve` refuses with `unavailable`/`resolver` at capacity. Bundled OpenShell
allows 1024 pending exchange openings and 1024 online Git decisions, with 256
per Sandbox for each, plus 1024 accepted exchanges. It refuses excess Git
decisions with `online_authorization_denied` and excess model middleware requests.
Token authentication saturation returns HTTP 503.

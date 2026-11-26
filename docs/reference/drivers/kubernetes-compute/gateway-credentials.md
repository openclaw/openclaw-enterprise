# Gateway startup credentials

Kubernetes Compute delivers explicitly selected static OCC TokenService Sources to dedicated Gateways. Configure the exact Source in [Configuration secret bindings](../../configuration/secrets.md#secret-bindings); Slack credential inputs continue to use canonical Namespace Secrets.

The Worker checks the deploying actor's and Agent service principal's exact grants and the revision's selected owner before and after reading TokenService. Compute receives the value and owner version in memory. It creates `gateway-secrets-<agent-hash>-<revision-hash>` in the Gateway Pod namespace, stores values in Kubernetes Secret `data`, and records Source versions by environment destination in the private `openclaw.dev/gateway-source-versions` annotation. The Gateway Deployment uses `env[].valueFrom.secretKeyRef`. The Configuration and Pod template contain no value; base64 encoding is not encryption. Namespace workload managers can mount the Secret and are trusted with its contents.

A replacement Pod for a running revision reuses that revision's staged Secret. A new managed revision reads the current Source into a separate Secret. An unlaunched retry replaces values and versions together. Compute checks current authorization immediately before each Gateway launch operation. Canonical Namespace Secrets remain direct references.

On stop, retirement, or abandonment, Compute waits for the revision's Gateway Pods to stop, then deletes its staged Secret. Failed deletion can leave a copy until cleanup succeeds. Cleanup does not delete owner material or another revision's Secret. Withdrawal cannot erase an existing process environment; see [Source withdrawal](../../credential-sources/withdrawal.md).

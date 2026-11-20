---
rfc: index.md
---

# Design discussion: pulling the Git credential

Could the Credential Proxy fetch a scoped token when the Agent first needs it? This proposed alternative to [online request authorization with installed credentials](online-authorization.md) keeps per-request authorization in OCE. The cold-cache contract remains open.

![On a cache miss OCE checks the operation before releasing a token to the verified proxy. Every allowed destination still needs a fresh request decision before sending.](../../../docs/assets/credential-proxy/credential-pull-proposal.png)

Today the worker installs the credential through the OpenShell management API. In this proposal the proxy first checks a local allowlist. An unlisted destination stops there. For a listed destination, a cache miss triggers a request for the credential bound to this execution. A hit skips that transfer. Both paths still require a fresh operation decision before the proxy sends.

### What changes for Git?

```mermaid
sequenceDiagram
    participant S as OpenShell supervisor
    participant G as OpenShell Gateway
    participant W as OCE worker
    alt Current delivery at startup or renewal
        W->>G: Install prepared token
        G->>S: Deliver provider update
    else Proposed delivery on first use
        opt Supervisor has no usable token for this grant
            S->>W: Request token for held Git operation
            W->>W: Check execution, recipient and grant
            W-->>S: Return scoped token on allow
        end
    end
    S->>W: Authorize held Git request and loaded version
    W-->>S: Allow or deny
```

A miss in the supervisor cache can use a token OCE has already prepared. The proposal changes Git token delivery. Sandbox provisioning and other Gateway uses have their own lifecycle.

The open contract question is the first request. Today's `authorize` takes the version already installed at the recipient. Checking the operation **before releasing any token bytes** needs an earlier decision, followed by evidence that the same recipient installed that version. The proposal grants the proxy no general Secret lookup. See the [repository Git authority](../../../packages/contracts/src/protected-repository-git.ts).

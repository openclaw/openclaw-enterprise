---
rfc: index.md
---

# Design discussion: pulling the Git credential

Could the Credential Proxy fetch a scoped token when the Agent first needs it? This proposed alternative to [online request authorization with installed credentials](online-authorization.md) keeps per-request authorization in OCE. The cold-cache contract remains open.

![On a cache miss OCE checks the operation before releasing a token to the verified proxy. Every allowed destination still needs a fresh request decision before sending.](../../../docs/assets/credential-proxy/credential-pull-proposal.png)

Today the worker installs the credential through the OpenShell management API. In this proposal the proxy first checks a local allowlist. An unlisted destination stops there. For a listed destination, a cache miss triggers a request for the credential bound to this execution. A hit skips that transfer. Both paths still require a fresh operation decision before the proxy sends.

### What changes for Git?

```mermaid
flowchart LR
    W["OCE worker<br/>prepare installation token"]
    G["Remove from token delivery<br/>Gateway provider update"]
    R["Add on cache miss<br/>OCE checks operation and recipient"]
    S["Credential Proxy"]
    A["OCE worker<br/>authorize this request"]
    W --> G --> S
    W -.-> R -.->|"Release scoped token"| S
    S -->|"Both paths"| A
    classDef removed fill:#fce8e6,stroke:#b42318,color:#651813
    classDef added fill:#dcf5e5,stroke:#147d44,color:#104728
    class G removed
    class R added
```

Red marks the provider update that pull would replace for Git. Green and dashed arrows mark the proposed release check. Sandbox provisioning and other Gateway uses have their own lifecycle.

The open contract question is the first request. Today's `authorize` takes the version already installed at the recipient. Checking the operation **before releasing any token bytes** needs an earlier decision, followed by evidence that the same recipient installed that version. The proposal grants the proxy no general Secret lookup. See the [repository Git authority](../../../packages/contracts/src/protected-repository-git.ts).

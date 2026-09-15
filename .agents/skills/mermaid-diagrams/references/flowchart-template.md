# Flowchart template

This is an illustrative example, not a claim about any implementation. Replace
its nodes and edges with the subject being explained. In this example, solid
arrows show implemented connections; the dashed arrow marks pending integration.

```mermaid
---
config:
  htmlLabels: true
  flowchart:
    curve: linear
    nodeSpacing: 24
    rankSpacing: 40
    padding: 16
---
flowchart TB
  subgraph Configuration["Configuration"]
    API["<b>Configuration API</b><br/>Save a draft"] -->|persist| State[("<b>Stored state</b><br/>PostgreSQL")]
    State -->|not ready| Gate["<b>Deployment blocked</b><br/>Before side effects"]
  end

  subgraph Preparation["Explicit preparation"]
    Input["<b>Operator inputs</b><br/>Selected credentials"] -->|supply| Prepare
    Prepare["<b>Prepare resources</b><br/>Validate inputs"] -->|prepare| Ready["<b>Prepared resources</b><br/>Bounded capabilities"]
  end

  Prepare -->|check identity| State
  Ready -.->|not connected| Future["<b>Pending integration</b><br/>Production execution"]

  classDef draft fill:#DBEAFE,stroke:#2563EB,color:#172554,stroke-width:2px
  classDef input fill:#EDE9FE,stroke:#7C3AED,color:#2E1065,stroke-width:2px
  classDef operation fill:#CCFBF1,stroke:#0F766E,color:#134E4A,stroke-width:2px
  classDef blocked fill:#FEF3C7,stroke:#B45309,color:#78350F,stroke-width:2px
  classDef pending fill:#F1F5F9,stroke:#64748B,color:#334155,stroke-width:2px,stroke-dasharray:5 5

  class API,State draft
  class Input input
  class Prepare,Ready operation
  class Gate blocked
  class Future pending

  style Configuration fill:transparent,stroke:#60A5FA,stroke-width:1px
  style Preparation fill:transparent,stroke:#2DD4BF,stroke-width:1px
  linkStyle default stroke:#64748B,stroke-width:2px
```

# Flowchart template

This is an illustrative example, not a claim about any implementation. Replace
its nodes and edges with the subject being explained. In this example, solid
arrows show implemented connections; the dashed arrow marks pending integration.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 14px
    primaryTextColor: "#344054"
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
    clusterBkg: "#FAFBFC"
    clusterBorder: "#D8DEE6"
  flowchart:
    curve: linear
    nodeSpacing: 28
    rankSpacing: 32
    padding: 14
    diagramPadding: 12
    subGraphTitleMargin:
      top: 10
      bottom: 14
---
flowchart TB
  subgraph Configuration["Configuration"]
    API["<b>Configuration API</b><br/>Save a draft"] --->|persist| State[("<b>Stored state</b><br/>PostgreSQL")]
    State -->|not ready| Gate["<b>Deployment blocked</b><br/>Before side effects"]
  end

  subgraph Preparation["Explicit preparation"]
    Input["<b>Operator inputs</b><br/>Selected credentials"] -->|supply| Prepare
    Prepare["<b>Prepare resources</b><br/>Validate inputs"] -->|prepare| Ready["<b>Prepared resources</b><br/>Bounded capabilities"]
  end

  Prepare -->|check identity| State
  Ready -.->|not connected| Future["<b>Pending integration</b><br/>Production execution"]

  classDef draft fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef input fill:#F1EEF5,stroke:#A091AD,color:#3A3243,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef blocked fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  classDef pending fill:#F3F4F6,stroke:#98A2AE,color:#44505F,stroke-width:1px,stroke-dasharray:4 4
  class API,State draft
  class Input input
  class Prepare,Ready operation
  class Gate blocked
  class Future pending

  style Configuration fill:#FAFBFC,stroke:#D8DEE6,stroke-width:1px
  style Preparation fill:#FAFBFC,stroke:#D8DEE6,stroke-width:1px
  linkStyle default stroke:#8B949E,stroke-width:1px
```

Treat these values as a starting point. The longer `persist` arrow aligns the
phase starts; it remains one implemented connection. Keep the phase-title margin
separate from node padding, and inspect the result at its intended display width.
See Mermaid's [flowchart configuration](https://mermaid.js.org/config/schema-docs/config-defs-flowchart-diagram-config.html)
for spacing options.

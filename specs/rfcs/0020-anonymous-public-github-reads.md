---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# RFC-0020: Read known public GitHub repositories without a credential

Let an operator install an internal public reader and let a dedicated Agent
revision explicitly select it. An Agent can then inspect a known public pull
request, for example, without provisioning a GitHub App or repository binding.
This complements [RFC-0008's managed repository access](0008-repository-credentials/index.md);
that decision continues to own private access and contribution.

## Trust and lifetime

- **Installation.** The operator enables a private, credential-free reader and
  reserves its Service address through the retirement of every revision that
  selects it. The reader makes bounded GET requests only to the fixed GitHub API
  origin, forwards no caller headers, and stores no completed response. GitHub
  decides public visibility on each read. Provider failures, including pagination
  that cannot be completed within the reader's bounds, must be visible to the Agent.
- **Revision.** An ordinary dedicated Codex revision must explicitly allow that
  Service IP in its native proxy. Compute withholds both the discoverable skill
  and the exact private egress peer when a deny could cover the address. Each
  revision owns its grant through preparation and activation; stop or retirement
  removes only that revision's policy after its Pods terminate. There is no
  reason to enable broader local binding for this path.
- **Caller.** The private HTTP path exposes repository and file names to that
  network. Kubernetes policy constrains which managed Pods can reach the reader;
  the reader authenticates no person, Agent, or tenant. GitHub sees an anonymous
  request, and its quota is shared at the egress address. This is suitable for
  public data, not an authorization contract for managed repositories.

Review the new listener and provider I/O boundary with its security owner, and
qualify an actual Agent read as specified in the [implementation plan](../plans/0020-anonymous-public-github-reads.md).

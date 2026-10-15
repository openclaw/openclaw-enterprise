# Read known public GitHub repositories

An operator can give ordinary dedicated Codex Agents a read-only path to public
GitHub repository metadata, pull requests, issues, releases and small source files.
The reader sends an anonymous HTTPS GET to `api.github.com` for each read. GitHub
decides what is public at that moment. The Installation needs no GitHub App,
repository binding or token for this capability. For private access or contributions,
use [managed repository credentials](repository-credentials.md).

## Enable the reader

The default is off. In the `codex` Installation profile input, set
`publicGithubRead.enabled: true`, `clusterIP` to an available IPv4 address
reserved in the Service range, and `upstreamCidrs` to the approved IPv4 CIDRs for
`api.github.com`. The profile renders both Helm values and the matching
`drivers.compute.configuration.network.publicGithubRead` peer. Use an enforcing
NetworkPolicy implementation.

Select the reader in a dedicated Agent's Configuration or Preset, then deploy a
new revision. In `plugins.entries.codex.config.appServer.networkProxy`, set
`enabled: true` and add the exact reserved IP as a `domains` key with value
`allow`. This makes the permission part of the immutable revision; enabling the
Service alone does not change existing Agents. Use `mode: limited` and keep
`allowLocalBinding: false` for this path.

Keep the Service and its address allocated until every revision that allows the
address has retired, including when disabling the feature or reverting a controller.
To retire it, remove the IP allow from affected Agent Configurations and Presets,
deploy the Agents again, retire old revisions, then remove the Compute peer
and disable the Helm reader. Kubernetes
enforces the Service address; NetworkPolicy restricts Agent egress to the reader
Pod and TCP port, rather than trusting whichever Pod might acquire an address.

The supported path is single-cluster Kubernetes, dedicated Codex, an ordinary
Compute-owned Harness, and an explicitly enabled Codex network proxy, as in
[Standard Codex](../guides/topics/standard-codex-preset.md). A disabled or absent
proxy, an unselected reader, or a denied reader address receives no grant or
skill. Compute also withholds both if it cannot rule out a deny, such as a
domain glob. It leaves the native proxy policy intact. The egress policy selects
only the revision that opted in. Preparing or activating a successor preserves
the serving revision's choice; stopping or retiring a revision removes its own policy.
Reader selection is frozen at admission. A revision created before the reader was
enabled stays unselected even if its proxy already allowed that address. Disabling
or changing the configured reader peer does not itself trigger reconciliation of
an active revision. To avoid interruption, deploy an unselected successor and
retire the old revision before changing the peer; stopping the Agent also terminates
its Harness. If a selected revision is prepared or activated after its peer is
removed or changed, Compute first removes that revision's grant to narrow new
connections, then stops its Harness and waits for its Pods to terminate before
reporting a configuration failure. Removing a NetworkPolicy does not guarantee
that an existing connection closes. A GET admitted before withdrawal completes
may drain; the stopped Harness cannot start a new one afterward. Deploy a new revision to select a replacement peer. Apply the
database migration before starting a controller that writes the new admission
fact, and complete the rollout before admitting revisions with that controller.

The private ClusterIP serves plain HTTP. Repository and file names are visible to
that in-cluster path and to GitHub. NetworkPolicy selects managed Agent Pods in
managed tenant namespaces; it does not authenticate a user or isolate anonymous
quota by tenant. The reader runs without a service account token, credentials,
writable volume, Ingress or externally exposed Service. Its egress permits cluster
DNS and HTTPS to the operator-supplied CIDRs.

## Use and troubleshoot

Ask the Agent to use its `public-github-read` skill for a repository whose public
name you know. The revision mounts the skill read-only in the Gateway for
discovery and in the Harness for native Codex. Supported
paths below `/repos/{owner}/{repository}` are repository metadata, `pulls`,
`issues` or `releases` lists and numeric details, and `contents/{path}`.
Directories return metadata; files up to 1 MiB return inline base64. Each path
component must contain 1–100 ASCII letters, digits, periods, underscores or
hyphens, and cannot be `.` or `..`; filenames containing spaces are unsupported.
GitHub limits directory listings to 1000 entries. At that limit, the reader
reports the listing as possibly incomplete instead of returning it as complete. Pagination
links are relative to the reader. Issue-list links preserve a bounded GitHub
`after` or `before` cursor and the original filters. If a next link cannot be
represented safely or goes beyond page 1000, the reader reports an incomplete
listing. When looking for merges, filter by
`merged_at` and use the descending `updated_at` order to tell when the pages cover
the requested dates. The reader offers no search, Git clone, arbitrary
destination, redirects, client-header forwarding or write operations.

A `404` can mean missing or private. GitHub's anonymous quota is small and
shared at the egress IP; `429` gives a retry time. Each Agent Pod gets one read
in flight, held until its provider read ends, even if the client gives up; a
second concurrent read receives `429` with a short retry time. A busy reader
returns `503`. Each provider read is bounded to 24 seconds and 12 MiB, with
at most three distinct reads in flight. Only simultaneous identical reads can share a result;
completed results are never cached. A failed or incomplete listing cannot
establish there were zero matches. See the [Agent read flow](../flows/public-github-reads.md)
for the revision, policy and request boundaries.

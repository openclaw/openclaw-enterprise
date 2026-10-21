# OpenShell Git route restarts

The worker verifies each admitted Sandbox's [OpenShell Git route](openshell-git.md)
itself, and never issues or replays material to recover one. This page says what a
Gateway restart, a worker restart or a failed read does to a running Agent's route,
when the worker reopens it without a new version, and what the worker log says.

## Failed reads

A read the worker cannot complete is not a verdict. While the Gateway Pod is being
replaced (an upgrade, node drain or restart), or a read times out, the route closes
and Git requests are denied; the worker reads again with a bounded backoff (1 s
doubling to 10 s) and reopens the route, without a new version, once the same
installation verifies. Nothing is rewritten or replayed meanwhile.

## Gateway restart

A replaced Gateway Pod gives every running Sandbox's supervisor a new control
session when it reconnects. The worker adopts that session, so no version is
redeployed, only when the verified observation is the same installation as before:
the same Sandbox ID, provider and attachment epoch, the same supervisor process and
network instance IDs, credentials installed and policy active, and the revisions
and provider generation the Gateway's receipt and this worker's own last write
expect. A changed process or network instance ID closes the route for good as
`supervisor_replaced` (a replaced Sandbox as `execution_replaced`). Stated limit:
in OpenShell 0.1.4 (`5a7728c3`) the process and network instance IDs are reported
by the supervisor itself (its hello and readiness messages:
`crates/openshell-server/src/grpc/provider_readiness.rs`,
`crates/openshell-supervisor-process/src/delegated.rs`,
`crates/openshell-server/src/compute/mod.rs`), not attested by the Gateway, which
authenticates only the sandbox principal for that Sandbox ID. Until OpenShell
provides an attested reconnect identity (a planned change), continuity across a
Gateway restart rests on that principal and the supervisor's own claims. No
material is issued or replayed on adoption.

## Worker restart

A worker restart (a rollout, an OOM kill, a node drain, an upgrade) does not
require a new version either. The worker records each route it prepares in
PostgreSQL (`occ.credential_deliveries`): the Sandbox, the binding id the Sandbox
presents, the provider generation it wrote, a reference to the material that
generation carries and the last verified observation. Never a token. The restarted
(or replacement) worker adopts the route from that record on its first maintenance
pass, re-observes the installation and reopens the route only when the full
observation verifies as the recorded one: the same Sandbox ID, provider, profile
version and attachment epoch, the same supervisor process and network instance
IDs, and the recorded generation at the Gateway. It then reads the material again
from prepared custody: the same version needs no provider write, a newer one (the
material was renewed while the worker was down) installs by the ordinary rotation.
Nothing is replayed. Git requests are denied (`no_binding`, then `route_pending`)
from the restart until that first verified read, typically well under a minute.
A route that does not verify, a route whose previous worker stopped in the middle
of a provider write (its outcome is unknown) and a withdrawn route are closed for
good with their reason: the Agent stays active and needs a new version.

The record is a fence as well: a worker whose record another worker has adopted
drops its copy of the route as `worker_replaced` (logged as a
`worker.openshell-git-route-warning` with `status: closed`), serves no new request
after that check and writes nothing more, so the worker holding the work-queue
claim is the only one that rotates it; a request already past its fence check is
still answered with the same material. The dropped copy is no tombstone: a worker
that holds the claim again re-adopts the record (each adoption moves the fence).
A request whose fence check the store does not answer is denied as
`store_unavailable` without closing the route. A Sandbox prepared by a release
before this record existed is not adopted: a restart still requires a new version
for it, logged as `worker_restarted`.

## What the worker log says

`worker.error` with `OPENSHELL_GIT_RECONCILIATION_REQUIRED` carries the `reason`
(for example `execution_replaced`, `supervisor_replaced`, `write_unknown`,
`worker_restarted` once per version when a restarted or other worker finds a
Sandbox without a route record, or `gateway_unauthorized` when the Gateway refuses
the worker's identity), the Namespace, Agent, revision and `repositoryRef`.
`worker.openshell-git-route-warning` reports a route closed by a failed read
(`status: unobserved` with `gateway_unavailable`, `timeout`, `read_failed`), a
copy another worker replaced (`status: closed`, `reason: worker_replaced`) or, on
the first request refused for it, material the version had and lost
(`status: pending`, `reason: material_unavailable`). `worker.openshell-git-route`
reports a route adopted from its record after a restart (`status: adopted`,
`reason: worker_restarted`, with the adoption `fence`) and its restoration with the
outage's `durationMs` (`reason: supervisor_reconnected` when it reopened on a new
supervisor session, `reason: worker_restarted` when a restarted worker reopened
it: that duration counts from the adoption, not from the restart). Each request
the worker refuses logs one `worker.openshell-git-denied` line;
[OpenShell Git refusals](openshell-git-refusals.md) lists its reason codes and what
the Agent sees.

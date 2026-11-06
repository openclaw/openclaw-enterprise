---
status: Proposed
implementation_status: Partially implemented
author: freeqaz-openai
---

# Bind private workspace preparation to the workload owner

A replacement Harness must be able to open its retained files. When the
workspace parent is private (mode `0700`), preparing it as a different user
can strand the very files the deployment means to preserve. The OpenShell
preparer infers the UID from a Kubernetes Namespace and sets GID equal to UID.
The OpenShell compute driver selects both values independently for its actual
workload placement.

## Proposed contract

For Sandbox Drivers that prepare private storage, add a read-only deployment
check for the selected workspace. The Sandbox Driver asks its provider for the
effective UID, GID, and placement identity. OCC records the successful result
against the immutable candidate revision before admission can supersede the
serving revision. Bind the observation to the exact selected Driver,
Namespace, Agent, Harness, and Configuration generation. A refused or
unsupported check leaves the predecessor running and its claim untouched.
Other storage topologies need no observation. Before each destructive predecessor
Stop, the worker asks the selected Compute Driver to check the pending
replacement. The Sandbox Driver revalidates the binding and refuses an unbound
candidate queued before upgrade. Active revision maintenance and cleanup retain
their existing paths.

Compare the candidate with the owner of retained data before allowing a new
exclusive revision. A previous bound identity or a verified predecessor
workload can establish that owner. If retained private data exists and the
owner cannot be established, or its UID is incompatible, keep the predecessor
and require an operator to resolve ownership. A new GID alone does not remove
owner access to a private directory. Keep the GID explicit in the bound pair.

The OpenShell Sandbox Driver must revalidate the bound observation before
preparing the volume. Use the bound UID and GID for the non-root preparer.
Send the observation to OpenShell as a create precondition. The provider
compares it with the placement and pair it will actually use to construct
the workload. A mismatch refuses creation. A later provider reconfiguration
can still stop a cutover after the old workload has drained.

## Dependencies and acceptance

OCE implements admission, storage preparation, and the create precondition. The pinned Gateway lacks this contract. A Namespace annotation, a default
pair, and the predecessor Pod each fail to establish a future workload's
identity. Avoid an operator override, a privileged ownership migration, or a
wider directory mode. Existing workload cleanup must remain available.

Exercise an unsupported Gateway and an incompatible retained owner through
deployment. Verify that each refusal precedes predecessor Stop and PVC
mutation. On a supporting Gateway with explicit distinct UID and GID, deploy
two revisions to the same PVC, verify the actual workload and directory
owners and retained bytes, and verify that a second UID sharing the workload
group cannot rename its private files.

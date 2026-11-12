# Docker Observer-Container Deployment Backend Design v1

Status: Accepted inert design, not authorized for construction or execution
Backend identity: docker-observer-container-v1
Repository baseline reviewed: 519c53ebdbb3267251834709f4f76316350c941e

## 1. Decision and phase boundary

This document defines a separately versioned Docker observer-container deployment backend. It does not reopen, replace, or revise the completed inert systemd deployment-artifact architecture. The two architectures may coexist, but only one observer execution contract may be authoritative for an invocation.

This artifact is design-only. It grants no authority to build or pull an image, create or start a container, create or change a Docker network, activate a service, modify systemd, install files, change credentials, run production validation, commit, or push.

The governing progression remains:

1. contract and design;
2. inert candidate artifacts;
3. validation;
4. acceptance;
5. separately authorized construction or execution.

## 2. Reviewed implementation baseline

The reviewed Docker compute implementation creates one ownership-labelled bridge network per OCC Namespace. Gateway and Agent runtime containers each receive an independent network namespace attached only to that bridge. Runtime container creation uses the derived Namespace network as HostConfig.NetworkMode and also supplies a matching NetworkingConfig.EndpointsConfig entry.

The workspace initializer is a separate, short-lived container using NetworkMode none. It is not evidence for runtime observation and must remain isolated.

The reviewed implementation contains no observer role, no container network-namespace sharing path, no post-runtime-creation lifecycle hook, and no network connect or disconnect operation. Existing generic lifecycle hooks prepare dependencies before workload start and revoke them before teardown; they do not expose Docker container identities and must not be extended merely to expose engine-specific resources.

## 3. Architectural conclusion

An observer independently attached to the Namespace bridge would receive a separate interface and address. That is sufficient for peer communication but not for passive observation of another container's packets. The observer must instead share the exact target workload container's network namespace.

The Docker representation for the design is:

HostConfig.NetworkMode = container:<verified-target-container-id>

The observer creation request must omit NetworkingConfig.EndpointsConfig, ExposedPorts, PortBindings, PublishAllPorts, hostname, links, DNS overrides, extra hosts, independent aliases, and all additional network attachments.

There is no fallback to bridge attachment, host networking, or another Namespace network.

## 4. Explicit opt-in and authoritative configuration

The backend is disabled by default. Enabling it requires an authoritative observer invocation record that names the backend version, immutable observer image reference, observation scope, target runtime role, maximum duration, output bound, evidence destination, and cleanup policy. An image variable alone must never enable observation.

The invocation record must be immutable after admission. Changes to backend version, image identity, target role, duration, capture scope, or evidence destination require a new invocation and a new admission decision.

## 5. Target selection and topology

The observer target must be an already-created, running, ownership-verified OCC workload container. The backend resolves the target internally from immutable OCC identities and must reject an arbitrary caller-supplied container name or identifier.

Target-role mapping is explicit:

- embedded OpenClaw topology targets the gateway container;
- dedicated Codex topology targets the exact-revision Agent container for Harness-originated DNS;
- dedicated gateway DNS is outside that scope unless a separately admitted observer invocation targets the gateway.

One observer container shares exactly one target container's network namespace. One observer invocation must not span multiple targets, Agents, revisions, or Namespaces.

## 6. Target resolution and revalidation

Before observer creation, the backend must resolve the deterministic expected workload name, inspect it, obtain its immutable container identifier, and verify all applicable ownership metadata:

- managed equals true;
- compute driver equals docker;
- Namespace identifier equals the admitted Namespace;
- Agent identifier equals the admitted Agent;
- revision identifier equals the admitted revision when the target role is revision-owned;
- role equals the admitted target role;
- state is running;
- the target is attached only to the expected owned Namespace network.

Immediately before sending the observer create request, the backend must reinspect the target by immutable container identifier and repeat those checks. A missing, stopped, replaced, mismatched, ambiguously resolved, or foreign target fails closed.

The observer must bind to the verified immutable container identifier, not a reusable container name. The backend must never fall back to the Namespace bridge when target resolution or revalidation fails.

## 7. Observer identity and ownership

The observer container must carry the existing managed-resource ownership labels plus observer-specific labels sufficient for exact discovery and cleanup:

- managed;
- compute driver;
- Namespace identifier;
- Agent identifier;
- revision identifier;
- role observer;
- observer backend version;
- target role;
- observation invocation identifier;
- bounded expiry;
- an admitted non-secret target-identity representation.

The target-identity representation must not expose credentials, environment values, endpoint details, or unrelated engine metadata. The observer must not reuse the gateway, agent, or workspace-setup role.

Every adoption, reuse, stop, removal, or cleanup decision must reinspect the observer and verify its complete expected ownership. A same-name container with incomplete or conflicting labels is foreign and must be refused.

## 8. Creation placement and lifecycle seam

Observer creation belongs inside the separately versioned Docker observer backend because the generic Compute lifecycle contract intentionally does not expose concrete container identities, commands, placement, or network policy.

The backend may create an observer only after:

1. the target runtime container has been created;
2. its ownership has been verified;
3. it is running and its expected network attachment exists;
4. the observer invocation has been admitted;
5. the observer image has passed immutable identity qualification;
6. target revalidation immediately before creation succeeds.

The design does not add an engine-specific field to WorkloadLaunchContext and does not add a Docker-container identity to ComputeLifecycleHooks. Existing hooks may continue to prepare or revoke independent dependencies, but they do not create, select, or attach the observer.

## 9. Container security profile

The observer must use a dedicated immutable image qualified by digest before admission. The image must contain only the observer runtime and required libraries. It must not contain Docker or Podman clients, an engine-socket client, package managers, repository credentials, cloud credentials, or workload credentials.

The container-create contract must apply these boundaries:

- non-root user unless later capability proof establishes a narrower safe exception;
- read-only root filesystem;
- all Linux capabilities dropped by default;
- no-new-privileges enabled;
- no privileged mode;
- no host PID, IPC, UTS, user, cgroup, or mount namespace sharing;
- no engine socket or host bind mounts;
- no workload state or workspace volumes;
- no secrets or workload environment variables;
- no published or exposed ports;
- no autonomous restart policy;
- bounded memory, CPU, process, temporary-storage, and log-output budgets.

Capture authority must be minimized. NET_ADMIN is prohibited unless a later separately reviewed design proves it indispensable and receives explicit acceptance. The preferred design uses only minimum packet-capture authority, expected to be NET_RAW, but that remains unaccepted until image-level and engine-level validation proves necessity and sufficiency.

The target and observer may share only the network namespace. Sharing the target PID namespace is prohibited. The observer must not inspect target processes, filesystems, environment, mounts, credentials, or memory.

## 10. Passive DNS observation contract

The observer is a passive sensor. It may open only the admitted capture interface in the shared network namespace and apply a bounded DNS-specific capture filter. It must not transmit packets, issue DNS requests, bind a service listener, modify routes, addresses, firewall state, resolver configuration, interface flags, neighbor state, or traffic-control state.

The admitted filter must restrict capture to the protocol, address family, port, direction, and endpoint scope required by the observer purpose. Capture-all behavior is prohibited. Payload retention must be separately bounded and must exclude unrelated traffic.

Startup must fail closed when:

- the expected capture interface is absent or ambiguous;
- the observed namespace identity does not match the verified target context;
- the required capture authority is unavailable;
- the filter cannot be installed exactly;
- output or evidence storage cannot enforce its bounds;
- the target exits or its network namespace becomes unavailable before capture readiness.

Readiness means the observer has entered the verified target network namespace, opened the admitted interface, installed the exact filter, and activated bounded capture. Process existence alone is not readiness.

## 11. Bounded invocation and evidence

Every invocation must define a maximum wall-clock duration, maximum captured-record count, maximum encoded output size, and cancellation path. Reaching any bound must stop capture and enter deterministic cleanup.

The observer may write only admitted evidence fields. Raw credentials, authorization material, unrelated packet payloads, container environment, engine responses, and host identifiers are prohibited. Evidence must identify the invocation, backend version, qualified image digest, target ownership scope, admitted filter identity, start and stop outcomes, bounds reached, and cleanup outcome without exposing secret material.

The observer must not stream evidence to an arbitrary network destination from inside the shared namespace. Evidence transfer requires a separately designed owner-controlled channel that does not grant general network transmission authority. Until such a channel is accepted, only bounded engine-managed logs or a dedicated non-workload evidence mount with a separately specified ownership and write contract may be considered.

## 12. Stop, replacement, and cleanup ordering

An observer is bound to one immutable target-container identifier. It must not follow a reusable target name to a replacement container. If reconciliation replaces the target, the old observer must be removed. Continued observation requires a new invocation, admission decision, target resolution, and revalidation.

Cleanup ordering is mandatory:

1. request observer termination;
2. wait within a bounded grace period;
3. force-remove the exact ownership-verified observer if necessary;
4. verify observer absence;
5. only then stop or remove the target runtime;
6. remove remaining Agent-owned resources;
7. remove the Namespace network only after all Namespace-owned containers are absent.

StopRevision, retireRevision, failed workload-preparation cleanup, Agent deletion, and deleteNamespace must discover observers through exact ownership labels and remove them before their targets. A failure to verify or remove an owned observer blocks target and Namespace teardown. Cleanup must be idempotent and retry-safe. Absence counts as successful removal only after exact identity-resolution rules have been applied.

## 13. Engine compatibility and qualification

Initial backend qualification is Docker-only. The reviewed upstream Moby contract recognizes container network mode and rejects incompatible hostname, link, DNS, extra-host, exposed-port, and published-port settings. Local static inspection found Docker CLI 29.9.2 but did not prove daemon acceptance because no engine request was authorized.

Podman compatibility is unproven. The backend must reject observer use when the selected engine has not passed a separately accepted qualification for the exact container-create request and cleanup behavior. Docker qualification must not be treated as Podman qualification.

Engine preflight must fail closed unless all of these properties have accepted evidence:

- the engine accepts HostConfig.NetworkMode using container plus the verified target identifier;
- no independent observer endpoint or address is created;
- prohibited networking fields are absent and rejected by local admission before an engine request;
- target stop, removal, and replacement behavior is understood and covered by cleanup tests;
- ownership-labelled observer discovery and forced removal are reliable;
- cancellation and request timeouts cannot silently leave an unowned observer;
- the engine's capability and security behavior matches the accepted observer image contract.

A failure or unknown result must not trigger bridge attachment, host networking, privileged mode, weakened filtering, or use of a different engine. Qualification evidence is versioned by backend version, engine identity, API behavior, observer image digest, and accepted security profile.

## 14. Required inert validation and acceptance gates

Before any constructed backend may be accepted for execution, validation must prove at minimum:

- exact target resolution from OCC identities and rejection of arbitrary container identifiers;
- complete target ownership revalidation immediately before observer creation;
- exact container network-mode request construction using the immutable target identifier;
- omission of EndpointsConfig, exposed ports, port bindings, published ports, hostname, links, DNS overrides, extra hosts, aliases, and additional networks;
- observer ownership labels and refusal of foreign or partially labelled resources;
- observer-first cleanup in stop, replacement, failed preparation, Agent deletion, and Namespace deletion paths;
- retry-safe cleanup after timeout, cancellation, partial creation, readiness failure, and target disappearance;
- no independent observer network endpoint or address;
- separation from other Agents and Namespaces;
- passive-only DNS visibility and absence of observer packet transmission or network mutation;
- exact readiness semantics, duration bounds, record bounds, output bounds, and evidence redaction;
- minimum capability proof, including explicit evidence that NET_ADMIN is not granted;
- Docker qualification independently from any later Podman qualification.

Validation must include structural tests of the container-create request, fault-injection tests at each create, start, readiness, cancellation, and removal boundary, and separately authorized real-engine tests. Real-engine tests remain outside this artifact's authorization.

Acceptance of this design does not authorize implementation. After design acceptance, any candidate code, image definition, test harness, or engine validation requires a new separately authorized workflow.

## 15. Explicit non-effects

This inert artifact does not:

- modify the completed systemd observer architecture;
- select Docker as the active observer backend;
- enable observation for any Namespace, Agent, or revision;
- define or accept an observer image;
- grant NET_RAW, NET_ADMIN, privileged mode, or any other capability;
- create, start, stop, inspect, or remove a Docker or Podman resource;
- contact a container engine;
- alter OCC lifecycle hooks or public contracts;
- modify services, systemd, installation state, credentials, repository history, or production state;
- authorize commit, push, deployment, or runtime validation.

## 16. Open design dependencies

The following remain deliberately unresolved and must be completed before construction acceptance:

1. the exact observer image and immutable digest policy;
2. the exact capture implementation and filter representation;
3. proof of the minimum required Linux capability under the accepted image user model;
4. the owner-controlled evidence channel and its persistence, permissions, and deletion contract;
5. observer readiness and terminal evidence schemas;
6. the exact Docker API qualification procedure and supported engine/API matrix;
7. the OCC configuration and admission record schema;
8. the internal backend seam used after target runtime creation;
9. compensation behavior when the observer is created but its request response is interrupted;
10. the complete conformance, fault-injection, and separately authorized real-engine validation plan.

Podman support is not an open assumption. It is excluded until a distinct qualification and acceptance record establishes parity for the exact backend contract.

## 17. Design acceptance boundary

This document is the accepted Docker observer-container design under the separate explicit acceptance decision tied to its exact file identity. Its acceptance is design-only: it remains inert and uncommitted, and it does not authorize construction, execution, deployment, or runtime validation.

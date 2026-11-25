import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCKER_OBSERVER_BACKEND_VERSION,
  dockerObserverContainerCreateRequest,
} from "../../apps/controller/src/drivers/compute/docker/observer-container-contract.ts";

test("Docker observer request shares only the immutable target network namespace", () => {
  const request = dockerObserverContainerCreateRequest({
    image: "observer@example.invalid/observer@sha256:qualified",
    immutableTargetContainerId: "target-container-id",
    ownership: {
      namespaceId: "namespace-observer",
      agentId: "agent-observer",
      revisionId: "revision-observer",
      targetRole: "agent",
      invocationId: "invocation-observer",
      expiresAt: "2026-11-21T18:00:00.000Z",
      targetIdentity: "target-identity",
    },
  });

  assert.equal(DOCKER_OBSERVER_BACKEND_VERSION, "docker-observer-container-v1");
  assert.equal(request.Image, "observer@example.invalid/observer@sha256:qualified");
  assert.equal(request.HostConfig.NetworkMode, "container:target-container-id");
  assert.deepEqual(request.Labels, {
    "org.openclaw.enterprise.managed": "true",
    "org.openclaw.enterprise.compute-driver": "docker",
    "org.openclaw.enterprise.namespace-id": "namespace-observer",
    "org.openclaw.enterprise.agent-id": "agent-observer",
    "org.openclaw.enterprise.revision-id": "revision-observer",
    "org.openclaw.enterprise.role": "observer",
    "org.openclaw.enterprise.observer-backend": "docker-observer-container-v1",
    "org.openclaw.enterprise.observer-target-role": "agent",
    "org.openclaw.enterprise.observer-invocation-id": "invocation-observer",
    "org.openclaw.enterprise.observer-expires-at": "2026-11-21T18:00:00.000Z",
    "org.openclaw.enterprise.observer-target-identity": "target-identity",
  });
  assert.deepEqual(request.HostConfig, {
    NetworkMode: "container:target-container-id",
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Privileged: false,
    RestartPolicy: { Name: "no" },
  });
});

test("Docker observer request structurally omits independent networking and attachment fields", () => {
  const request = dockerObserverContainerCreateRequest({
    image: "observer@example.invalid/observer@sha256:qualified",
    immutableTargetContainerId: "target-container-id",
    ownership: {
      namespaceId: "namespace-observer",
      agentId: "agent-observer",
      revisionId: "revision-observer",
      targetRole: "gateway",
      invocationId: "invocation-observer",
      expiresAt: "2026-11-21T18:00:00.000Z",
      targetIdentity: "target-identity",
    },
  });

  const topLevel = request as unknown as Record<string, unknown>;
  const hostConfig = request.HostConfig as unknown as Record<string, unknown>;
  for (const field of ["NetworkingConfig", "ExposedPorts", "Hostname"]) {
    assert.equal(Object.hasOwn(topLevel, field), false, field);
  }
  for (const field of [
    "PortBindings",
    "PublishAllPorts",
    "Links",
    "Dns",
    "DnsOptions",
    "DnsSearch",
    "ExtraHosts",
    "NetworkModeOverride",
  ]) {
    assert.equal(Object.hasOwn(hostConfig, field), false, field);
  }
  assert.equal(Object.hasOwn(topLevel, "Env"), false, "Env");
  assert.equal(Object.hasOwn(topLevel, "Cmd"), false, "Cmd");
  assert.equal(Object.hasOwn(hostConfig, "Mounts"), false, "Mounts");
  assert.equal(Object.hasOwn(hostConfig, "CapAdd"), false, "CapAdd");
  assert.equal(Object.hasOwn(hostConfig, "PidMode"), false, "PidMode");
});

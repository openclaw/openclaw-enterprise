import assert from "node:assert/strict";

export const registryImage =
  "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";

// Local Setup's PostgreSQL pin: developmentPostgres in internal/occdev/openshell_k3d.go.
export const postgresImage =
  "docker.io/library/postgres:18.6@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae";

// The runtime image's pinned Node base, which the provider image shares.
export function runtimeNodeBaseImage(dockerfile) {
  const image = /^ARG NODE_RUNTIME_BASE_IMAGE=(\S+@sha256:[a-f0-9]{64})$/m.exec(dockerfile)?.[1];
  assert.ok(image, "deploy/runtime/Dockerfile pins no NODE_RUNTIME_BASE_IMAGE");
  return image;
}

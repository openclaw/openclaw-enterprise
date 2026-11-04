import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { GATEWAY_RUNTIME_ENTRYPOINT as dockerGateway } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_STOP_TIMEOUT_MS,
  NATIVE_WORKER_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { withTestOwnerLabel } from "./docker-test-owner.mjs";

const current = {
  dockerGateway,
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_STOP_TIMEOUT_MS,
  NATIVE_WORKER_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
};
let historical;

export function runtimeImageEntrypoints() {
  const version = process.env.OCC_TEST_STAGING_CODEX_VERSION ?? "0.164.0";
  assert.ok(["0.164.0", "0.163.0-alpha.2"].includes(version));
  if (version === "0.164.0") {
    return current;
  }
  const reviewedRelease = "54bfa7fc1b99e362450beb5f9211e164991fa7b4";
  assert.equal(process.env.EXPECTED_OCC_REVISION, reviewedRelease);
  if (historical !== undefined) {
    return historical;
  }
  // Staging has already bound this local image ID to the publication receipt.
  // Read the production bootstrap programs inside the matching published controller;
  // the current controller must continue refusing this older runtime in production.
  const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
  assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/);
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const options = { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
  const [inspected] = JSON.parse(execFileSync(docker, ["image", "inspect", image], options));
  assert.equal(
    inspected.Config.Labels["org.opencontainers.image.revision"],
    reviewedRelease,
    "Historical staging requires its matching published controller.",
  );
  const program = `
import { GATEWAY_RUNTIME_ENTRYPOINT as dockerGateway } from "/app/apps/controller/src/drivers/compute/docker/index.ts";
import { AGENT_RUNTIME_ENTRYPOINT, GATEWAY_RUNTIME_ENTRYPOINT, GATEWAY_STOP_TIMEOUT_MS,
  NATIVE_WORKER_ENTRYPOINT, PLUGIN_RUNTIME_HELPERS } from "/app/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
process.stdout.write(JSON.stringify({ dockerGateway, AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT, GATEWAY_STOP_TIMEOUT_MS, NATIVE_WORKER_ENTRYPOINT, PLUGIN_RUNTIME_HELPERS }));
`;
  const container = execFileSync(
    docker,
    withTestOwnerLabel(docker, [
      "create",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      program,
    ]),
    options,
  ).trim();
  let selected;
  const errors = [];
  try {
    selected = JSON.parse(execFileSync(docker, ["start", "--attach", container], options));
  } catch (error) {
    errors.push(error);
  }
  try {
    execFileSync(docker, ["rm", "-f", container], { ...options, stdio: "ignore" });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "Historical entrypoint extraction and cleanup failed.");
  }
  assert.deepEqual(Object.keys(selected).sort(), Object.keys(current).sort());
  for (const [name, value] of Object.entries(current)) {
    assert.equal(typeof selected[name], typeof value, `Missing production entrypoint ${name}`);
  }
  historical = selected;
  return historical;
}

import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  composeOptions,
  createFixture,
  prepareLifecycleCommands,
  readJsonLines,
  runDevUp,
} from "../helpers/dev-up.mjs";

// Run real Compose preflight for both Compute profiles before any resource mutation.

for (const driver of ["docker", "kubernetes"]) {
  for (const service of ["controller", "postgres", "browser-proxy"]) {
    test(`${driver} dev-up rejects host networking for ${service} before startup`, async (t) => {
      const fixture = await createFixture(t);
      await prepareLifecycleCommands(fixture);
      const override = join(fixture.directory, "host-network.yaml");
      await writeFile(
        override,
        `services:\n  ${service}:\n    network_mode: host\n    networks: !reset []\n    ports: !reset []\n`,
      );
      const options =
        driver === "kubernetes"
          ? ["--env-file", fixture.emptyEnv, "-f", override]
          : composeOptions(fixture, override);
      const result = await runDevUp(["--", ...options], {
        ...fixture.env,
        OCC_DEVELOPMENT_COMPUTE_DRIVER: driver,
        OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
      });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        // The final browser overlay restores its network, so Compose itself rejects host mode.
        service === "browser-proxy" && driver === "docker"
          ? /Docker Compose config failed/
          : new RegExp(`Compose ${service} must use the development network`),
      );
      await assert.rejects(stat(fixture.env.OCC_DEVELOPMENT_STATE_DIRECTORY), { code: "ENOENT" });
      const commands = await readJsonLines(fixture.env.SAFETY_LOG);
      assert.ok(commands.some((entry) => entry.args.includes("config")));
      assert.equal(
        commands.some((entry) =>
          entry.args.some((arg) => ["up", "down", "create", "delete"].includes(arg)),
        ),
        false,
      );
    });
  }
}

for (const driver of ["docker", "kubernetes"]) {
  for (const [service, port, label] of [
    ["controller", 3000, "controller"],
    ["postgres", 5432, "PostgreSQL"],
    ["browser-proxy", 8443, "browser-proxy"],
  ]) {
    for (const [mapping, publication, error] of [
      ["public", `"0.0.0.0:39000:${port}"`, "must publish only on loopback"],
      ["target-only", `"${port}"`, "must publish only on loopback"],
      [
        "loopback-dynamic",
        `{target: ${port}, host_ip: "127.0.0.1"}`,
        "must select an explicit host port",
      ],
    ]) {
      test(`${driver} dev-up rejects ${mapping} ${service} ports rendered by real Compose before startup`, async (t) => {
        const fixture = await createFixture(t);
        await prepareLifecycleCommands(fixture);
        const stateDirectory = join(fixture.directory, "new-state");
        const override = join(fixture.directory, "unsafe-port.yaml");
        await writeFile(override, `services:\n  ${service}:\n    ports:\n      - ${publication}\n`);
        // Kubernetes supplies its own base files and project; do not load the base twice.
        const options =
          driver === "kubernetes"
            ? ["--env-file", fixture.emptyEnv, "--project-directory", ".", "-f", override]
            : composeOptions(fixture, override);
        const result = await runDevUp(
          ["--key-output", join(fixture.directory, "key.json"), "--", ...options],
          {
            ...fixture.env,
            OCC_DEVELOPMENT_COMPUTE_DRIVER: driver,
            OCC_DEVELOPMENT_CONTROL_PLANE: "compose",
            OCC_DEVELOPMENT_STATE_DIRECTORY: stateDirectory,
            OCC_DEVELOPMENT_KUBERNETES_CLUSTER: "occ-dev-new",
          },
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`Compose ${label} port ${error}`));
        await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
        const commands = await readJsonLines(fixture.env.SAFETY_LOG);
        assert.equal(
          commands.some((entry) =>
            entry.args.some((arg) => ["up", "down", "create", "delete"].includes(arg)),
          ),
          false,
        );
        assert.ok(
          commands.some((entry) => entry.command === "docker" && entry.args.includes("config")),
        );
      });
    }
  }
}

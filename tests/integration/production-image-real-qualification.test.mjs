import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const pairScript = fileURLToPath(
  new URL("../../scripts/upgrade-repository-image-probe.mjs", import.meta.url),
);
const imageScript = fileURLToPath(
  new URL("../../scripts/upgrade-image-identity.py", import.meta.url),
);

const controllerImage = process.env.OCC_PROBE_CONTROLLER_IMAGE;
const brokerImage = process.env.OCC_PROBE_BROKER_IMAGE;
const oldControllerImage = process.env.OCC_PROBE_OLD_CONTROLLER_IMAGE;
const oldBrokerImage = process.env.OCC_PROBE_OLD_BROKER_IMAGE;
const architectures = { x64: "linux/amd64", arm64: "linux/arm64" };
const nativePlatform = process.platform === "linux" ? architectures[process.arch] : undefined;

test(
  "staged controller and broker images qualify through the real Driver and broker",
  {
    skip:
      !controllerImage || !brokerImage || !nativePlatform
        ? "staged image pair is not configured"
        : false,
    timeout: 360000,
  },
  async () => {
    const { stdout } = await execute(
      process.execPath,
      [pairScript, controllerImage, brokerImage, nativePlatform],
      { timeout: 350000 },
    );
    const proof = JSON.parse(stdout);
    assert.equal(proof.controller.image, controllerImage);
    assert.equal(proof.broker.image, brokerImage);
    assert.equal(proof.reports.recover.outcome, "missing");
    assert.equal(proof.reports.reserve.outcome, "unavailable");
  },
);

test(
  "incompatible old and new staged image pairs are rejected",
  {
    skip:
      !controllerImage || !brokerImage || !oldControllerImage || !oldBrokerImage || !nativePlatform
        ? "staged current and old image pairs are not configured"
        : false,
    timeout: 2100000,
  },
  async () => {
    // Establish a working fixture and staged images before attributing failures
    // to either incompatibility rather than Docker, setup, or a missing image.
    for (const image of [controllerImage, brokerImage, oldControllerImage, oldBrokerImage]) {
      await execute("python3", [imageScript, image, nativePlatform], { timeout: 150000 });
    }
    await execute(process.execPath, [pairScript, controllerImage, brokerImage, nativePlatform], {
      timeout: 350000,
    });
    await assert.rejects(
      execute(process.execPath, [pairScript, controllerImage, oldBrokerImage, nativePlatform], {
        timeout: 350000,
      }),
      (error) => {
        assert.match(error.stderr, /broker durable admission capability is missing/);
        return true;
      },
    );
    await assert.rejects(
      execute(process.execPath, [pairScript, oldControllerImage, brokerImage, nativePlatform], {
        timeout: 350000,
      }),
      (error) => {
        assert.match(error.stderr, /controller admission probe is missing/);
        return true;
      },
    );
    await assert.rejects(
      execute(process.execPath, [pairScript, oldControllerImage, oldBrokerImage, nativePlatform], {
        timeout: 350000,
      }),
      (error) => {
        assert.match(error.stderr, /controller admission probe is missing/);
        return true;
      },
    );
  },
);

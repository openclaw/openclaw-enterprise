import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

function id(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/u.test(value);
}

function digest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function requireTarget(target) {
  if (!id(target?.sourceId) || !id(target?.configurationId)) {
    throw new Error("Invalid stock Strands Box target");
  }
}

export function requireModelKey(key) {
  if (typeof key !== "string" || !/^[!-~]{16,4096}$/u.test(key) || key.startsWith("strands_box_")) {
    throw new Error("Invalid stock Strands Box model credential");
  }
  return key;
}

async function projection(control, path) {
  const deadline = performance.now() + 180_000;
  while (!control.destroyed && performance.now() < deadline) {
    try {
      const bytes = readFileSync(path);
      if (bytes.length > 16384) throw new Error();
      return JSON.parse(bytes.toString());
    } catch (error) {
      // In particular, do not propagate a parser message containing secret bytes.
      if (error.code !== "ENOENT") throw new Error("Invalid stock Strands Box projection");
      await delay(500);
    }
  }
  throw new Error("Stock Strands Box staging interrupted");
}

// Only the trusted launcher reads material. Retain the same value through
// release. No subsequent Secret update may change which version Box receives.
export async function holdStockKey(
  control,
  target,
  podUid,
  config,
  policy,
  materialPath = "/run/strands-material/material.json",
  releasePath = "/run/strands-release/release",
) {
  requireTarget(target);
  const { sourceId, configurationId } = target;
  const interrupt = () => control.destroy();
  // Before release no bytes may travel from the listener to the workload.
  control.on("data", interrupt);
  control.on("error", interrupt);
  control.once("end", interrupt);
  try {
    const material = await projection(control, materialPath);
    const sandboxId = material?.sandboxId;
    const delivery = material?.deliveries?.[0];
    const version = delivery?.version;
    const value = requireModelKey(delivery?.value);
    const owner = { sandboxId, configurationId, podUid };
    if (
      !id(sandboxId) ||
      !id(podUid) ||
      !id(version) ||
      !isDeepStrictEqual(material, { ...owner, deliveries: [{ sourceId, version, value }] })
    ) {
      throw new Error("Invalid stock Strands Box delivery");
    }
    const receipt = {
      versions: { [sourceId]: version },
      challenge: randomBytes(32).toString("hex"),
      configHash: createHash("sha256").update(config).digest("hex"),
      policyHash: createHash("sha256").update(policy).digest("hex"),
    };
    control.write(JSON.stringify(receipt) + "\n");
    const release = await projection(control, releasePath);
    if (control.destroyed || !isDeepStrictEqual(release, { ...owner, ...receipt })) {
      throw new Error("Invalid stock Strands Box release");
    }
    control.pause();
    control.write('"released"\n');
    return value;
  } finally {
    control.off("data", interrupt);
    control.off("error", interrupt);
    control.off("end", interrupt);
  }
}

// Exactly two launcher records precede the contained process's frames. Once
// released, workload bytes cannot modify the receipt or assert another version.
export function stockStage(target) {
  requireTarget(target);
  let staged;
  return {
    get held() {
      return !staged?.released;
    },
    consume(message) {
      if (staged?.released) return false;
      if (staged) {
        if (message !== "released") throw new Error("Invalid stock Strands Box release record");
        staged = { ...staged, released: true };
      } else {
        const { challenge, configHash, policyHash, versions } = message;
        const version = versions?.[target.sourceId];
        if (
          !id(version) ||
          !digest(challenge) ||
          !digest(configHash) ||
          !digest(policyHash) ||
          !isDeepStrictEqual(message, {
            challenge,
            configHash,
            policyHash,
            versions: { [target.sourceId]: version },
          })
        ) {
          throw new Error("Invalid stock Strands Box staging record");
        }
        staged = { ...message, released: false };
      }
      return true;
    },
    async status(native) {
      const result = staged?.released ? await native() : { state: "starting" };
      return staged ? { ...result, staged } : result;
    },
  };
}

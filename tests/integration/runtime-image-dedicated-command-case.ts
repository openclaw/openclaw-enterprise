import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { probeDedicatedCommand } from "../fixtures/runtime-image-startup/dedicated-command.ts";
import {
  codexRpc,
  parseJson,
  record,
  text,
  commandResult,
} from "../fixtures/runtime-image-startup/wire.ts";
import { renderProbe } from "./runtime-image-startup-support.ts";

export async function verifyDedicatedCommand(image: string, historicalCodex: boolean) {
  // Substitute only authentication results and the app-server transport. The emitted
  // startup computes native settings; the image's actual Codex executes the shell.
  // Docker supplies isolation; this offline check proves no model turn or provider access.

  const tokenHash = createHash("sha256").update("synthetic-transport-token").digest("hex");
  const probe = renderProbe(probeDedicatedCommand, [
    tokenHash,
    historicalCodex,
    codexRpc,
    parseJson,
    record,
    text,
    commandResult,
  ]);
  const { stdout } = await runDocker(
    [
      "run",
      "-i",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/home/node:size=128m,uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
      "--entrypoint",
      "node",
      image,
      "-e",
      probe,
    ],
    {},
    AGENT_RUNTIME_ENTRYPOINT,
  );
  assert.match(stdout, /native-repository-shell-ready/);
}

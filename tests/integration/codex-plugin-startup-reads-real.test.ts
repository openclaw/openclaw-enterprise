import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  nativeStartupScript,
  observeProcessClose,
  parseNativeStartupReceipt,
} from "../fixtures/codex-native-startup-probe.ts";
import { runDockerCommand } from "../helpers/runtime-image-docker.ts";

// The companion protocol fixture owns deterministic timing and write-order
// assertions. This opt-in case verifies the pinned external server contract.
test(
  "generated metadata reads and disabled-selection startup use a native Codex app-server",
  {
    skip: process.env.OCC_TEST_CODEX_STARTUP_READS_REAL !== "1",
    timeout: 180_000,
  },
  async (t) => {
    const runtimeImage = process.env.OCC_TEST_KUBERNETES_AGENT_IMAGE;
    const token = process.env.CODEX_ACCESS_TOKEN;
    assert.ok(
      runtimeImage && /(?:^sha256:|@sha256:)[a-f0-9]{64}$/.test(runtimeImage),
      "an immutable native runtime image is required",
    );
    assert.ok(token, "an explicitly authorized service-account token is required");

    const script = nativeStartupScript(token);
    const name = `oce-native-startup-${randomUUID()}`;
    const child = spawn(
      "docker",
      ["run", "--rm", "-i", "--name", name, "--entrypoint", "node", runtimeImage],
      { stdio: ["pipe", "pipe", "pipe"], signal: t.signal, killSignal: "SIGKILL" },
    );
    const closed = observeProcessClose(child);
    const redact = (text: string) => text.replaceAll(token, "[REDACTED]");
    let receiptVerified = false;
    t.after(async () => {
      // On a timeout the test signal stops the CLI before this hook removes its container.
      await closed;
      try {
        await runDockerCommand("docker", ["rm", "--force", name], {
          timeout: 20_000,
          redact: [token],
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes(`No such container: ${name}`)) {
          return;
        }
        if (receiptVerified) {
          throw error;
        }
        t.diagnostic(redact(String(error)));
      }
    });

    let output = "";
    let errors = "";
    let inputError: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
    });
    child.stdin.once("error", (error) => {
      inputError = error;
    });
    child.stdin.end(script);

    const { code, signal, error } = await closed;
    if (error !== undefined) {
      throw error;
    }
    assert.equal(code, 0, `native startup container exited (${code ?? signal}): ${redact(errors)}`);
    if (inputError !== undefined) {
      throw inputError;
    }
    const receipt = parseNativeStartupReceipt(output);
    receiptVerified = true;
    t.diagnostic(JSON.stringify(receipt));
  },
);

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { redactQaError, registerQaSecret } from "../helpers/qa-secrets.ts";

export async function failingQaCommand(value: string, encoding: "utf8" | "buffer") {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]); process.exit(3)",
        value,
      ],
      { encoding, timeout: 40_000, killSignal: "SIGKILL" },
    );
  } catch (error: unknown) {
    assert.ok(error instanceof Error);
    assert.ok("code" in error && error.code === 3, "the fixture command must exit with code 3");
    assert.ok("cmd" in error && typeof error.cmd === "string");
    assert.ok("stdout" in error && "stderr" in error);
    assert.ok(
      encoding === "buffer"
        ? Buffer.isBuffer(error.stdout) && Buffer.isBuffer(error.stderr)
        : typeof error.stdout === "string" && typeof error.stderr === "string",
      "the fixture command must supply both streams with the requested encoding",
    );
    assert.ok(
      error.cmd.endsWith(value) && String(error.stdout) === value && String(error.stderr) === value,
      "the fixture command must carry the synthetic value in argv and both streams",
    );
    return error;
  }
  assert.fail("the fixture command must fail");
}

// Running this file directly gives the parent an independent node:test reporter.
if (import.meta.main) {
  const value = process.argv[2];
  assert.ok(value, "the reporter needs a synthetic value");
  registerQaSecret(value);
  test("command failure", async () => {
    const error = await failingQaCommand(value, "buffer");
    error.cause = new AggregateError([new Error("nested " + value)], "aggregate", {
      cause: "string " + value,
    });
    Object.assign(error, { headers: new Map([["authorization", Buffer.from(value)]]) });
    Object.defineProperty(error, "detail", { enumerable: true, get: () => "getter " + value });
    throw redactQaError(error);
  });
}

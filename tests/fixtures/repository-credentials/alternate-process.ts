import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ServiceLimits } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { within } from "../../helpers/wait-for.ts";
import type { AlternateProcessInput } from "./alternate-process-child.ts";
import { createTlsMaterial } from "./process.ts";
import { createTestResourceScope, type FixtureOwner } from "./resources.ts";
import { appRoot } from "./runtime.ts";
import { createServiceConfiguration } from "./service-fixture.ts";

type ExitReceipt = { code: number | null; signal: NodeJS.Signals | null };

export async function createAlternateProcessFixture(
  owner: FixtureOwner,
  limits?: Partial<ServiceLimits>,
) {
  const resources = createTestResourceScope(owner);
  const { keyFile, certFile } = await createTlsMaterial(resources);
  const config = await createServiceConfiguration(resources, limits);

  function start(scenario: AlternateProcessInput["scenario"] = "listen") {
    // Only the provider is a fixture. Startup, admission and shutdown use the real
    // process composition with Unix and loopback HTTPS listeners.
    const child = fork(new URL("./alternate-process-child.ts", import.meta.url), [], {
      env: { PATH: process.env.PATH, REPOSITORY_CREDENTIALS_APP_ROOT: appRoot },
      execArgv: [],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    assert.ok(child.stdin && child.stdout && child.stderr);

    let stdout = "";
    let stderr = "";
    let processError: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      processError = new Error("alternate service fixture process failed");
    });
    const closed = new Promise<ExitReceipt>((resolve, reject: (error: Error) => void) => {
      child.once("close", (code, signal) => {
        if (processError) {
          reject(processError);
        } else {
          resolve({ code, signal });
        }
      });
    });

    // Join close so logs finish and the child can no longer access the socket or TLS files.
    resources.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    });

    const ready = within(
      new Promise<void>((resolve, reject: (error: Error) => void) => {
        child.once("message", (message: unknown) => {
          if (message === "ready") {
            resolve();
          } else {
            reject(new Error("alternate service fixture sent an invalid readiness message"));
          }
        });
        void closed.then(() => {
          const reason = stderr.split("\n").includes("startup-failed")
            ? "startup-failed"
            : "alternate service exited before readiness";
          reject(new Error(reason));
        }, reject);
      }),
      "alternate service readiness",
      5_000,
    );
    // A child can reject readiness before a caller reaches its assertion.
    void ready.catch(() => {});
    const input: AlternateProcessInput = { scenario, config, tls: { keyFile, certFile } };
    child.stdin.on("error", () => {
      // The close receipt owns failure reporting if the child exits before reading stdin.
    });
    child.stdin.end(JSON.stringify(input));

    return {
      ready,
      closed,
      async stop(signal: "SIGKILL" | "SIGTERM") {
        assert.ok(child.kill(signal), "could not signal the owned alternate service");
        return closed;
      },
      output: () => [stdout, stderr],
    };
  }

  return { socketPath: config.gateway.controlSocket, start };
}

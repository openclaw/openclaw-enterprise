import assert from "node:assert/strict";
import test from "node:test";
import { runLauncher } from "./k3d-launcher-fixture.ts";

export function registerLauncherLifecycleCases() {
  test("k3d reset does not require a model credential", async (context) => {
    const output = await runLauncher(context, "docker", ["reset"], { apiKey: "" });
    assert.match(output, /test state reset; cluster and images preserved/);
  });

  test("k3d reset stops before the database reset when namespace enumeration fails", async (context) => {
    await assert.rejects(
      runLauncher(context, "docker", ["reset"], { apiKey: "", namespaceListFailure: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, 37);
        assert.ok("stderr" in error && typeof error.stderr === "string");
        assert.match(error.stderr, /namespace inventory unavailable/);
        return true;
      },
    );
  });

  test("k3d reset removes a stale demo marker", async (context) => {
    const output = await runLauncher(context, "docker", ["reset"], {
      apiKey: "",
      staleDemo: true,
    });
    assert.match(output, /test state reset; cluster and images preserved/);
  });

  test("k3d down removes a stale demo marker", async (context) => {
    await runLauncher(context, "docker", ["down"], { staleDemo: true });
  });

  test("k3d down discovers native OpenClaw state without a Harness flag", async (context) => {
    const output = await runLauncher(context, "docker", ["down"], {
      preparedHarness: "openclaw",
    });
    assert.match(output, /environment removed/);
  });

  test("k3d serializes demo, test, reset, and down against an active lifecycle owner", async (context) => {
    for (const args of [[], ["test"], ["reset"], ["down"]]) {
      await assert.rejects(
        runLauncher(context, "docker", args, { activeLock: true }),
        /a k3d demo command is already running/,
      );
    }
  });

  test("k3d rejects another checkout's prepared state before reset or reuse", async (context) => {
    for (const action of ["reset", "test"]) {
      await assert.rejects(
        runLauncher(context, "docker", [action], { foreignState: true }),
        /prepared state belongs to another repository checkout/,
      );
    }
  });

  test("k3d validates prepared state metadata before reset", async (context) => {
    await assert.rejects(
      runLauncher(context, "docker", ["reset"], { stateVersion: 2 }),
      /unsupported prepared state version: 2/,
    );
    await assert.rejects(
      runLauncher(context, "docker", ["reset"], { resourceOwner: "openclaw-ci-foreign" }),
      /resource owned by another prefix/,
    );
  });
}

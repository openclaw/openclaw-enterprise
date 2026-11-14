import assert from "node:assert/strict";
import test from "node:test";
import { runLauncher } from "./k3d-launcher-fixture.ts";

export function registerLauncherModelCases() {
  test("k3d defaults to the foreground OpenClaw and OCC console demo", async (context) => {
    await runLauncher(context, "docker");
  });

  test("k3d model flags override inherited and prepared settings for both Harnesses", async (context) => {
    for (const [harness, command] of [
      ["codex", ["test"]],
      ["codex", []],
      ["openclaw", ["test"]],
      ["openclaw", ["demo"]],
    ] as const) {
      const recorded = await runLauncher(
        context,
        "podman",
        [
          ...command,
          "--harness",
          harness,
          "--base-url",
          "https://models.example.test/api/v1",
          "--model-id",
          "codex/vendor/model",
        ],
        {
          inheritedModel: "inherited-model",
          inheritedBaseUrl: "https://inherited.example.test/v1",
          preparedModel: "prepared-model",
          preparedBaseUrl: "https://prepared.example.test/v1",
        },
      );
      // The explicit outer provider protects a native ID whose namespace itself
      // is codex/ from the consumer's existing provider-ref normalization.
      assert.equal(
        recorded.model,
        `${harness === "codex" ? "codex" : "openai"}/codex/vendor/model`,
      );
      assert.equal(recorded.baseUrl, "https://models.example.test/api/v1");
      assert.equal(recorded.apiKeySet, true);
      assert.doesNotMatch(recorded.args.join(" "), /test-only-value/);
    }
  });

  test("k3d model options retain environment-only use and accept equals syntax", async (context) => {
    for (const harness of ["codex", "openclaw"]) {
      const inherited = await runLauncher(context, "podman", ["test", "--harness", harness], {
        inheritedModel: "vendor/model",
        inheritedBaseUrl: "https://models.example.test/v1",
      });
      assert.equal(inherited.model, "vendor/model");
      assert.equal(inherited.baseUrl, "https://models.example.test/v1");
      const flagged = await runLauncher(context, "podman", [
        "demo",
        "--harness",
        harness,
        "--model-id=vendor/model",
        "--base-url=https://models.example.test/v1",
      ]);
      assert.equal(flagged.model, `${harness === "codex" ? "codex" : "openai"}/vendor/model`);
      assert.equal(flagged.baseUrl, "https://models.example.test/v1");
    }
  });

  test("k3d rejects missing model option values and unsupported actions before preparation", async (context) => {
    for (const args of [
      ["test", "--base-url"],
      ["--model-id="],
      ["--model-id", "--base-url", "https://models.example.test/v1"],
    ]) {
      await assert.rejects(runLauncher(context, "podman", args), /requires a nonempty/);
    }
    await assert.rejects(
      runLauncher(context, "podman", ["info", "--model-id", "vendor/model"]),
      /supported only for demo and test/,
    );
  });

  test("k3d demo selects native OpenClaw through OpenShell", async (context) => {
    await runLauncher(context, "docker", ["demo", "--harness", "openclaw"]);
  });

  test("k3d fails immediately without a model credential in non-interactive use", async (context) => {
    await assert.rejects(
      runLauncher(context, "docker", [], { apiKey: "" }),
      /OPENAI_API_KEY is required for non-interactive use/,
    );
  });
}

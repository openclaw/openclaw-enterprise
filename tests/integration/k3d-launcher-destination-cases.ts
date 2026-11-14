import assert from "node:assert/strict";
import test from "node:test";
import { runLauncher } from "./k3d-launcher-fixture.ts";

export function registerNativeDestinationCases() {
  for (const afterReset of [false, true]) {
    test(`native launcher preserves custom destinations through ${afterReset ? "reset" : "fresh"} preparation`, async (context) => {
      for (const action of ["test", "demo"] as const) {
        const endpoint = "https://model.example.test/v1";
        const explicit = action === "test";
        const result = await runLauncher(
          context,
          "docker",
          [
            action,
            "--engine",
            "docker",
            "--harness",
            "openclaw",
            ...(explicit ? ["--base-url", endpoint] : []),
          ],
          {
            afterReset,
            realPreparationAdmission: true,
            inheritedBaseUrl: explicit ? "https://inherited.example.test/v1" : endpoint,
            preparedBaseUrl: "https://prepared.example.test/v1",
          },
        );
        assert.equal(result.baseUrl, endpoint);
        assert.equal(result.originalKey, true);
      }
    });
  }

  test("native launcher rejects malformed destinations before preparation", async (context) => {
    const malformed = "malformed-native-endpoint-sentinel";
    await assert.rejects(
      runLauncher(context, "docker", ["test", "--engine", "docker", "--harness", "openclaw"], {
        inheritedBaseUrl: malformed,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("stderr" in error && typeof error.stderr === "string");
        assert.ok("stdout" in error && typeof error.stdout === "string");
        assert.match(error.stderr, /The OpenShell model endpoint must be a valid absolute URL/);
        assert.doesNotMatch(error.stdout + error.stderr, new RegExp(malformed));
        return true;
      },
    );
  });
}

import assert from "node:assert/strict";
import test from "node:test";

test("QA command diagnostics retain the error while hiding generated and environment secrets", async (t) => {
  const { qaCommandFailureDetail, registerQaSecret } = await import("../helpers/qa-secrets.ts");
  registerQaSecret("generated-private-value");
  const output = qaCommandFailureDetail(
    "earlier detail\n".repeat(12) +
      "Docker service could not start: generated-private-value and process-private-value\nAuthorization: Bearer example-private-value\n",
    { PRIVATE_INPUT: "process-private-value" },
  );
  assert.match(output, /Docker service could not start/);
  assert.ok(output.split("\n").length <= 8);
  assert.doesNotMatch(
    output,
    /generated-private-value|process-private-value|example-private-value/,
  );
  await t.test(
    "native failure metadata keeps fixed classes without echoing response or log values",
    async () => {
      const { nativeTaskFailureSummary } =
        await import("../helpers/normal-agent-native-diagnostics.ts");
      const summary = nativeTaskFailureSummary(
        "thread/start: Codex did not grant the requested permission profile. Authorization: Bearer native-private-value",
      );
      assert.deepEqual(summary, {
        classes: ["profile-grant-mismatch"],
        nativeMethod: "thread/start",
      });
      assert.doesNotMatch(
        JSON.stringify(summary),
        /native-private-value|Authorization|Codex did not/,
      );
      assert.deepEqual(
        nativeTaskFailureSummary(" ".repeat(65_536) + "turn/start invalid api key"),
        {
          classes: ["unclassified"],
          nativeMethod: "unknown",
        },
      );
      assert.deepEqual(nativeTaskFailureSummary("unrecognized private-native-message"), {
        classes: ["unclassified"],
        nativeMethod: "unknown",
      });
    },
  );
  await t.test(
    "native requirements distinguish missing experimental fields from an explicit allowlist",
    async () => {
      const { nativePolicyRequirementsSummary } =
        await import("../helpers/normal-agent-native-diagnostics.ts");
      assert.deepEqual(nativePolicyRequirementsSummary({}), { available: false });
      assert.deepEqual(nativePolicyRequirementsSummary({ requirements: null }), {
        available: true,
        requirementsPresent: false,
      });
      const malformed = nativePolicyRequirementsSummary({
        requirements: {
          allowedPermissionProfiles: { ":workspace": "true" },
          defaultPermissions: "native-private-value",
        },
      });
      assert.equal(malformed.profileAllowlistPresent, "unknown");
      assert.equal(malformed.defaultProfileKind, "other-named");
      assert.doesNotMatch(JSON.stringify(malformed), /native-private-value/);
      assert.equal(
        nativePolicyRequirementsSummary({ requirements: { allowedPermissionProfiles: null } })
          .profileAllowlistPresent,
        false,
      );
      assert.equal(
        nativePolicyRequirementsSummary({ requirements: {} }).profileAllowlistPresent,
        "unknown",
      );
      const expected = "openclaw-network-0123456789abcdef";
      const summary = nativePolicyRequirementsSummary({
        requirements: {
          allowedPermissionProfiles: {
            ":workspace": true,
            ":read-only": true,
            [expected]: false,
          },
          defaultPermissions: ":workspace",
          modelProviders: { privateProvider: { apiKey: "native-private-value" } },
        },
      });
      assert.equal(summary.profileAllowlistPresent, true);
      assert.equal(summary.workspaceAllowed, true);
      assert.equal(summary.generatedNetworkProfilesAllowed, 0);
      assert.equal(summary.defaultProfileKind, "builtin-workspace");
      assert.doesNotMatch(
        JSON.stringify(summary),
        /0123456789abcdef|native-private-value|privateProvider|modelProviders/,
      );
    },
  );
});

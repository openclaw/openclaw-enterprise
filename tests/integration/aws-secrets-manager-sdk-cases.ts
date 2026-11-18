import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { AwsSecretsManagerSecretDriver } from "../../apps/controller/src/drivers/secret/aws-secrets-manager/index.ts";
import { backend, options, stored, type RecordValue } from "./aws-secrets-manager-fixture.ts";

test("SDK signs STS and creation with captured credentials at pinned endpoints through a simulated transport", async () => {
  for (const account of [options.accountId, "999999999999"]) {
    let resolutions = 0;
    const requests: { host: string; authorization: string; action: string }[] = [];
    let created:
      { Name: string; ClientRequestToken: string; Tags: RecordValue["Tags"] } | undefined;
    const handler = {
      handle: async (request: {
        protocol: string;
        hostname: string;
        headers: Record<string, string>;
        body: string | Uint8Array;
      }) => {
        assert.equal(request.protocol, "https:");
        const action = request.headers["x-amz-target"] ?? "GetCallerIdentity";
        requests.push({
          host: request.hostname,
          authorization: request.headers.authorization!,
          action,
        });
        let body: string | Uint8Array;
        if (request.hostname === "sts.us-east-1.amazonaws.com") {
          body = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${account}</Account><Arn>arn:aws:iam::${account}:role/workload</Arn><UserId>workload</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></GetCallerIdentityResponse>`;
        } else {
          assert.equal(request.hostname, "secretsmanager.us-east-1.amazonaws.com");
          if (action.endsWith("CreateSecret")) {
            created = JSON.parse(
              typeof request.body === "string"
                ? request.body
                : new TextDecoder().decode(request.body),
            ) as typeof created;
          }
          assert.ok(created);
          const ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${created.Name}-Ab123x`;
          body = JSON.stringify({
            ARN,
            Name: created.Name,
            VersionId: created.ClientRequestToken,
            Tags: created.Tags,
            VersionIdsToStages: { [created.ClientRequestToken]: ["AWSCURRENT"] },
          });
        }
        return { response: { statusCode: 200, headers: {}, body: new TextEncoder().encode(body) } };
      },
    };
    const driver = new AwsSecretsManagerSecretDriver(options, {
      credentials: async () => ({
        accessKeyId: `synthetic-key-${++resolutions}`,
        secretAccessKey: "synthetic-signing-key",
        expiration: new Date(Date.now() + 60_000),
      }),
      requestHandler: handler,
    });
    const identity = { id: `sec_${randomUUID()}`, namespaceId: `ns_${randomUUID()}`, name: "key" };
    if (account !== options.accountId) {
      await assert.rejects(driver.create(identity, "synthetic-value"), ScopeViolationError);
      assert.equal(requests.length, 1);
    } else {
      await driver.create(identity, "synthetic-value");
      assert.equal(requests[0]!.host, "sts.us-east-1.amazonaws.com");
      assert.ok(requests[1]!.action.endsWith("CreateSecret"));
      const signingKey = (authorization: string) => /Credential=([^/]+)/.exec(authorization)?.[1];
      assert.ok(signingKey(requests[0]!.authorization));
      assert.equal(signingKey(requests[0]!.authorization), signingKey(requests[1]!.authorization));
    }
  }
});

for (const mutation of ["PutSecretValue", "DeleteSecret"] as const) {
  for (const outcome of [
    "identity-failure",
    "invalid-identity",
    "lost-response",
    "service-rejection",
    "invalid-response",
    "success",
  ] as const) {
    test(`real SDK ${mutation}: ${outcome} distinguishes identity resolution from transport`, async () => {
      const b = backend();
      const secret = await stored(b);
      const record = Array.from(b.records.values())[0]!;
      const calls: string[] = [];
      let described = false;
      let signedDescribes = 0;
      let signedMutations = 0;
      let mutationResolutions = 0;
      const driver = new AwsSecretsManagerSecretDriver(options, {
        credentials: async () => {
          if (described) {
            mutationResolutions++;
            if (outcome === "identity-failure") {
              throw new Error("synthetic private identity diagnostic");
            }
          }
          let accessKeyId = "fixture-describe";
          if (described) {
            accessKeyId = outcome === "invalid-identity" ? "" : "fixture-mutation";
          }
          return {
            accessKeyId,
            secretAccessKey: "synthetic-signing-key",
            // Force the SDK's provider-backed identity to refresh after Describe.
            expiration: new Date(Date.now() + 60_000),
          };
        },
        requestHandler: {
          handle: async (request: {
            protocol: string;
            hostname: string;
            headers: Record<string, string>;
            body: string | Uint8Array;
          }) => {
            assert.equal(request.protocol, "https:");
            assert.equal(request.hostname, "secretsmanager.us-east-1.amazonaws.com");
            const action = request.headers["x-amz-target"]!.split(".")[1]!;
            calls.push(action);
            const input = JSON.parse(
              typeof request.body === "string"
                ? request.body
                : new TextDecoder().decode(request.body),
            );
            assert.equal(input.SecretId, record.ARN);
            const key = action === "DescribeSecret" ? "fixture-describe" : "fixture-mutation";
            assert.ok(request.headers.authorization!.includes(`Credential=${key}/`));
            assert.ok(
              request.headers.authorization!.includes("/us-east-1/secretsmanager/aws4_request"),
            );
            let response: unknown = record;
            if (action === "DescribeSecret") {
              signedDescribes++;
              described = true;
            } else {
              assert.equal(action, mutation);
              signedMutations++;
              if (outcome === "service-rejection") {
                return {
                  response: {
                    statusCode: 400,
                    headers: {
                      "x-amzn-errortype": "AccessDeniedException",
                      "content-type": "application/x-amz-json-1.1",
                    },
                    body: new TextEncoder().encode(
                      JSON.stringify({
                        __type: "AccessDeniedException",
                        message: "synthetic private AWS diagnostic",
                      }),
                    ),
                  },
                };
              }
              if (outcome === "lost-response") {
                throw new Error("synthetic private transport diagnostic");
              }
              response =
                outcome === "invalid-response"
                  ? {}
                  : {
                      ARN: record.ARN,
                      Name: record.Name,
                      VersionId: input.ClientRequestToken,
                      VersionStages: ["AWSCURRENT"],
                      DeletionDate: Date.now() / 1000,
                    };
            }
            return {
              response: {
                statusCode: 200,
                headers: {},
                body: new TextEncoder().encode(JSON.stringify(response)),
              },
            };
          },
        },
      });
      const result = await (
        mutation === "PutSecretValue"
          ? driver.update(secret, "synthetic-new")
          : driver.delete(secret)
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      const beforeTransport = outcome === "identity-failure" || outcome === "invalid-identity";
      // Count real HTTP handler invocations before checking diagnostics: a test name
      // or an injected send exception cannot establish the submission boundary.
      assert.deepEqual(calls, beforeTransport ? ["DescribeSecret"] : ["DescribeSecret", mutation]);
      assert.equal(
        signedDescribes,
        1,
        "ownership Describe was signed and transported successfully",
      );
      assert.equal(
        signedMutations,
        beforeTransport ? 0 : 1,
        "only validated mutation requests reached the fault boundary",
      );
      assert.ok(mutationResolutions > 0, "identity was resolved after successful signed Describe");
      if (outcome === "success") {
        assert.equal(result, undefined);
        assert.equal(
          mutationResolutions,
          1,
          "mutating client uses the captured identity without another provider refresh",
        );
      } else {
        assert.ok(result instanceof DependencyUnavailableError);
        let expected = "AWS Secret mutation may have applied; reconciliation required.";
        if (beforeTransport) {
          expected = "AWS Secret operation failed; no mutation was submitted.";
        } else if (outcome === "service-rejection") {
          expected = "AWS Secret mutation was rejected.";
        }
        assert.equal(result.message, expected);
      }
    });
  }
}

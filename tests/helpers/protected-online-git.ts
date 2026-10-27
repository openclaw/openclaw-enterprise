import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ProtectedRepositoryGitAuthority } from "../../packages/contracts/src/protected-repository-git.ts";
import type { OpenShellOnlineGitAuthorityOptions } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts";
import { protectedOpenShellGitOwner } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { openShellOnlineGitWire } from "./openshell-online-git-wire.mjs";

type Options = Omit<OpenShellOnlineGitAuthorityOptions, "identity" | "registrationName">;

/** Exercise the same adapter selected by bindRepositoryGit. Storage is deliberately a port
 * fixture; classification and the final signed RPC callback remain production code. */
export function protectedOnlineGitWire(t: TestContext, options: Options) {
  const authorize = options.authorizeOnlineRequest;
  const unavailable = async () => assert.fail("RPC authorization must not release material");
  const authority: ProtectedRepositoryGitAuthority = {
    readMaterial: unavailable,
    authorize: async () => assert.fail("online RPC must not use exact-send authority"),
    recipients: {
      observe: unavailable,
      beginInstall: unavailable,
      confirmInstall: unavailable,
    },
    online: {
      readMaterial: unavailable,
      authorize,
      githubInstallation: {
        readMaterial: unavailable,
        // Installation replies additionally bind scope, operation and the recipient fence.
        authorize: async (request, installed, signal) => {
          const result = await authorize(request, installed, signal);
          return result as Awaited<
            ReturnType<
              NonNullable<
                ProtectedRepositoryGitAuthority["online"]["githubInstallation"]
              >["authorize"]
            >
          >;
        },
      },
    },
  };
  return openShellOnlineGitWire(t, {
    ...options,
    ...protectedOpenShellGitOwner(authority),
  });
}

function completion<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function protectedOnlineGitBoundaryCases(
  t: TestContext,
  binding: import("../../apps/controller/src/drivers/egress-proxy/openshell-online-git-authority.ts").OpenShellOnlineGitBinding,
  request: () => object,
) {
  const { invoke, token, grpc } = await import("./openshell-online-wire.mjs");
  for (const offset of [-1, 0]) {
    await t.test(`the final live RPC callback at replyBy ${offset}ms`, async (t) => {
      const now = Date.now;
      let calls = 0;
      let liveAtBoundary = false;
      const { client, keys } = await protectedOnlineGitWire(t, {
        lookupBinding: async () => binding,
        authorizeOnlineRequest: async (q, installed, signal) => {
          calls += 1;
          const deadline = now() + 100;
          assert.ok(deadline < Date.parse(q.deadlineAt));
          // Change only wall time after classification. The RPC's monotonic budget remains
          // live, isolating the exclusive authority deadline at the real final callback.
          t.mock.method(Date, "now", () => {
            liveAtBoundary ||= !signal.aborted;
            return deadline + offset;
          });
          return {
            kind: "allow",
            exchangeId: q.exchangeId,
            requestDigestSha256: q.requestDigestSha256,
            ...installed,
            replyBy: new Date(deadline).toISOString(),
          };
        },
      });
      try {
        const response = (await invoke(
          client,
          "EvaluateHttpRequest",
          request(),
          token(keys, "supervisor", binding.sandboxId),
        )) as { decision: number };
        assert.equal(response.decision, offset < 0 ? 1 : 2);
        assert.equal(calls, 1);
        assert.equal(liveAtBoundary, true);
      } finally {
        t.mock.restoreAll();
      }
    });
  }

  for (const field of [
    "exchangeId",
    "requestDigestSha256",
    "preparationAttemptId",
    "materialVersion",
    "scope",
    "replyBy",
  ]) {
    await t.test(`a mismatched online ${field} denies without retry`, async (t) => {
      let calls = 0;
      const { client, keys } = await protectedOnlineGitWire(t, {
        lookupBinding: async () => binding,
        authorizeOnlineRequest: async (q, installed) => {
          calls += 1;
          return {
            kind: "allow",
            exchangeId: q.exchangeId,
            requestDigestSha256: q.requestDigestSha256,
            ...installed,
            replyBy: q.deadlineAt,
            [field]:
              field === "replyBy"
                ? new Date(Date.parse(q.deadlineAt) + 1).toISOString()
                : "mismatch",
          };
        },
      });
      const response = (await invoke(
        client,
        "EvaluateHttpRequest",
        request(),
        token(keys, "supervisor", binding.sandboxId),
      )) as { decision: number };
      assert.equal(response.decision, 2);
      assert.equal(calls, 1);
    });
  }

  for (const field of ["matched", "scope", "operation", "revisionId", "fence"]) {
    await t.test(
      field === "matched"
        ? "a matching installation decision allows once"
        : `a mismatched installation ${field} denies without retry`,
      async (t) => {
        let calls = 0;
        const scoped = {
          ...binding,
          scope: "github-installation" as const,
          installationId: "123",
          apiOrigin: "https://api.github.com",
        };
        const { client, keys } = await protectedOnlineGitWire(t, {
          lookupBinding: async () => scoped,
          authorizeOnlineRequest: async (q, installed) => {
            calls += 1;
            assert.ok("scope" in q);
            return {
              kind: "allow",
              exchangeId: q.exchangeId,
              requestDigestSha256: q.requestDigestSha256,
              ...installed,
              replyBy: q.deadlineAt,
              scope: q.scope,
              operation: q.operation,
              revisionId: installed.route.revisionId,
              fence: installed.route.fence,
              ...(field === "matched"
                ? {}
                : { [field]: field === "fence" ? installed.route.fence + 1 : "mismatch" }),
            };
          },
        });
        const response = (await invoke(
          client,
          "EvaluateHttpRequest",
          request(),
          token(keys, "supervisor", binding.sandboxId),
        )) as { decision: number };
        assert.equal(response.decision, field === "matched" ? 1 : 2);
        assert.equal(calls, 1, "the real classifier selected an installation operation");
      },
    );
  }

  await t.test(
    "cancelling a live RPC aborts the owner and never retries possible use",
    async (t) => {
      const entered = completion<void>();
      const aborted = completion<void>();
      let calls = 0;
      const { client, keys } = await protectedOnlineGitWire(t, {
        lookupBinding: async () => binding,
        authorizeOnlineRequest: async (q, installed, signal) => {
          calls += 1;
          entered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          aborted.resolve();
          return {
            kind: "allow",
            exchangeId: q.exchangeId,
            requestDigestSha256: q.requestDigestSha256,
            ...installed,
            replyBy: q.deadlineAt,
          };
        },
      });
      const metadata = new grpc.Metadata();
      metadata.set("authorization", token(keys, "supervisor", binding.sandboxId));
      const response = completion<{ code: number }>();
      const call = client.EvaluateHttpRequest(
        request(),
        metadata,
        { deadline: Date.now() + 5000 },
        (error: { code: number }) => response.resolve(error),
      );
      await entered.promise;
      call.cancel();
      assert.equal((await response.promise).code, grpc.status.CANCELLED);
      await aborted.promise;
      assert.equal(calls, 1);
    },
  );
}

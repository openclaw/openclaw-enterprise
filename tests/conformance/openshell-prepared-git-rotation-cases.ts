import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenShellPreparedGitProvider,
  OpenShellPreparedGitProviderError,
  type OpenShellPreparedGitReadFailure,
  type OpenShellPreparedGitScope,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { scope, signal, token, wire, type RecordedRequest } from "./openshell-prepared-git-wire.ts";

function isUpdate(
  entry: RecordedRequest,
): entry is Extract<RecordedRequest, { method: "UpdateProvider" }> {
  return entry.method === "UpdateProvider";
}

function refusedAs(readFailure: OpenShellPreparedGitReadFailure | undefined) {
  return (error: unknown): boolean =>
    error instanceof OpenShellPreparedGitProviderError &&
    error.outcome === "refused" &&
    error.readFailure === readFailure;
}

export function registerPreparedGitRotationCases(): void {
  // These cases exercise the product client over loopback gRPC with synthetic credentials.
  test("prepared Git static token and rotation use released fields without returning credentials or readiness", async (t) => {
    const { state, binding } = await wire(t);
    const first = token();
    const receipt = await binding.prepare(first, signal());
    assert.equal(receipt.update, "accepted");
    assert.equal(receipt.supervisor, "unknown");
    assert.equal(receipt.providerId, "provider-id");
    assert.equal(receipt.resourceVersion, "1");
    assert.equal(receipt.readiness.rpc, "GetSandboxProviderStatus");
    assert.equal(JSON.stringify(receipt).includes(first.value), false);
    assert.ok(state.profile);
    assert.deepEqual(state.profile.credentials, [
      {
        name: "installation_token",
        env_vars: ["GITHUB_TOKEN"],
        required: true,
        auth_style: "bearer",
        header_name: "authorization",
        stable_placeholder: true,
      },
    ]);
    assert.deepEqual(
      state.profile.endpoints.map(({ host, port, path, tls }) => ({ host, port, path, tls })),
      [
        {
          host: "github.com",
          port: 443,
          path: "/example/project.git/**",
          tls: undefined,
        },
        {
          host: "api.github.com",
          port: 443,
          path: "/repos/example/project/pulls",
          tls: undefined,
        },
      ],
    );
    assert.ok(state.provider);
    assert.equal(state.provider.credentials.GITHUB_TOKEN, first.value);
    assert.equal(state.provider.profile_workspace, scope.workspace);
    const initialExpiry = state.provider.credential_expiration_times?.GITHUB_TOKEN;
    assert.ok(initialExpiry);
    assert.equal(initialExpiry.seconds, String(Math.floor(Date.parse(first.expiresAt) / 1000)));
    const next = token("successor");
    const rotated = await binding.rotate(receipt, async () => next, signal());
    assert.ok(rotated);
    assert.equal(rotated.resourceVersion, "2");
    assert.equal(rotated.supervisor, "unknown");
    assert.equal(JSON.stringify(rotated).includes(next.value), false);
    const last = state.requests.at(-1);
    assert.ok(last && isUpdate(last));
    const update = last.request;
    const nextExpiry = update.credential_expiration_times?.GITHUB_TOKEN;
    assert.ok(nextExpiry);
    assert.equal(update.provider.metadata.resource_version, "1");
    assert.equal(update.provider.credentials.GITHUB_TOKEN, next.value);
    assert.equal(nextExpiry.seconds, String(Math.floor(Date.parse(next.expiresAt) / 1000)));
  });

  test("prepared Git refuses foreign, stale, changed-profile and replaced-workspace bindings before token update", async (t) => {
    const { state, binding, client } = await wire(t);
    const receipt = await binding.prepare(token(), signal());
    const { profile, provider } = state;
    assert.ok(profile && provider);
    const original = structuredClone(provider);
    for (const mutation of [
      (current: typeof original) => {
        current.metadata.id = "foreign-provider";
      },
      (current: typeof original) => {
        current.metadata.resource_version = "2";
      },
      (current: typeof original) => {
        current.metadata.labels = {};
      },
      () => {
        profile.resource_version = "2";
      },
      () => {
        state.workspaceId = "replacement-workspace";
      },
    ]) {
      state.provider = structuredClone(original);
      profile.resource_version = "1";
      state.workspaceId = scope.workspaceId;
      mutation(state.provider);
      await assert.rejects(
        binding.rotate(receipt, async () => token("rejected"), signal()),
        (error) =>
          error instanceof OpenShellPreparedGitProviderError && error.outcome === "refused",
      );
      assert.equal(state.requests.some(isUpdate), false);
    }
    const replacement = new OpenShellPreparedGitProvider(client, {
      ...scope,
      executionId: "successor",
    });
    await assert.rejects(
      replacement.rotate(receipt, async () => token(), signal()),
      /refused/,
    );
  });

  test("prepared Git preserves uncertain write outcomes and redacts private gateway failures", async (t) => {
    const { state, binding } = await wire(t);
    const receipt = await binding.prepare(token(), signal());
    state.lost = true;
    const next = token("private_successor");
    await assert.rejects(
      binding.rotate(receipt, async () => next, signal()),
      (error) =>
        error instanceof OpenShellPreparedGitProviderError &&
        error.outcome === "unknown" &&
        !String(error.stack).includes(next.value) &&
        error.cause === undefined,
    );
    assert.equal(state.requests.filter(isUpdate).length, 1);
    assert.ok(state.provider);
    assert.equal(
      state.provider.metadata.resource_version,
      "2",
      "lost reply cannot justify resubmission",
    );
  });

  test("prepared Git writes outlive the caller's read budget, and a caller out of time sends nothing", async (t) => {
    // Finding 2211: the caller's signal is a reconcile pass's read budget. A write, once sent,
    // runs to its own deadline: abandoning it would leave its outcome unknown and close the route.
    const { state, binding } = await wire(t);
    const abortOn = (sent: (entry: RecordedRequest) => boolean): AbortSignal => {
      const caller = new AbortController();
      state.onRequest = (request) => {
        if (sent(request)) {
          caller.abort(new Error("the pass ran out of time"));
        }
      };
      return caller.signal;
    };
    state.writeDelayMs = 200;
    const bootstrap = await binding.bootstrap(
      abortOn((entry) => entry.method === "ImportProviderProfiles"),
    );
    assert.equal(bootstrap.credentialState, "bootstrap");
    assert.ok(state.provider);
    assert.equal(state.provider.credentials.GITHUB_TOKEN, "oce-unprivileged-bootstrap-sentinel");
    const active = await binding.rotate(bootstrap, async () => token(), abortOn(isUpdate));
    assert.ok(active);
    assert.equal(active.credentialState, "active");
    assert.equal(active.resourceVersion, "2");
    assert.deepEqual(
      state.requests
        .filter(
          ({ method }) =>
            method === "ImportProviderProfiles" ||
            method === "CreateProvider" ||
            method === "UpdateProvider",
        )
        .map(({ method }) => method),
      ["ImportProviderProfiles", "CreateProvider", "UpdateProvider"],
    );
    state.writeDelayMs = 0;

    // Out of time before the write, for any reason (here the worker's claim ended): nothing is
    // sent, and the refusal is a timeout the caller retries, not a verdict on the provider.
    const late = new AbortController();
    const skipped = await binding.rotate(
      active,
      async () => {
        late.abort(new Error("claim lost"));
        return token("late");
      },
      late.signal,
    );
    assert.equal(skipped, undefined);
    assert.equal(state.requests.filter(isUpdate).length, 1);
    const fresh = await wire(t);
    const caller = new AbortController();
    fresh.state.onRequest = (request) => {
      if (request.method === "GetProvider") {
        caller.abort(new Error("claim lost"));
      }
    };
    await assert.rejects(fresh.binding.bootstrap(caller.signal), refusedAs("timeout"));
    assert.deepEqual([fresh.state.profile, fresh.state.provider], [undefined, undefined]);
    assert.deepEqual(
      fresh.state.requests.map(({ method }) => method),
      ["GetProviderProfile", "GetProvider"],
    );
    // Out of time just after the last read answered: the write does not start.
    const between = await wire(t);
    const ended = new AbortController();
    const getProvider = between.client.getProvider.bind(between.client);
    between.client.getProvider = async (...args) => {
      const answer = await getProvider(...args);
      ended.abort(new Error("claim lost"));
      return answer;
    };
    await assert.rejects(between.binding.bootstrap(ended.signal), refusedAs("timeout"));
    assert.deepEqual([between.state.profile, between.state.provider], [undefined, undefined]);
    assert.deepEqual(
      between.state.requests.map(({ method }) => method),
      ["GetProviderProfile", "GetProvider"],
    );

    // A gateway that refuses the worker's identity is a refusal, never a retryable read failure,
    // even when the caller's signal ends at the same moment.
    const denied = await wire(t);
    denied.state.denyReads = true;
    await assert.rejects(denied.binding.bootstrap(signal()), refusedAs(undefined));
    const deniedCaller = new AbortController();
    const getProfile = denied.client.getProviderProfile.bind(denied.client);
    denied.client.getProviderProfile = async (...args) => {
      try {
        return await getProfile(...args);
      } finally {
        deniedCaller.abort(new Error("claim lost"));
      }
    };
    await assert.rejects(denied.binding.bootstrap(deniedCaller.signal), refusedAs(undefined));
    assert.equal(denied.state.provider, undefined);
  });

  test("prepared Git sends a CAS precondition and fails closed on a concurrent gateway update", async (t) => {
    const { state, binding } = await wire(t);
    const receipt = await binding.prepare(token(), signal());
    state.conflict = true;
    await assert.rejects(
      binding.rotate(receipt, async () => token("racing"), signal()),
      /unknown/,
    );
    assert.ok(state.provider);
    assert.equal(state.provider.metadata.resource_version, "1");
    assert.equal(state.requests.filter(isUpdate).length, 1);
  });

  test("prepared Git settles a lent value's hold after its write, and a write whose hold ended sends nothing", async (t) => {
    // A lent Source's row stays held from the loan's checks until the write returns, so its
    // replacement or retirement waits; a Worker paused past the hold's end sends nothing.
    const held = async (end?: "before-write" | "invalid") => {
      const { state, binding } = await wire(t);
      const receipt = await binding.prepare(token(), signal());
      let open = true;
      const settled: number[] = [];
      const next = token(end ?? "held");
      const rotated = binding.rotate(
        receipt,
        async () => {
          if (end === "before-write") {
            open = false;
          }
          return {
            ...next,
            ...(end === "invalid" && { expiresAt: new Date(Date.now() + 7_200_000).toISOString() }),
            isCurrent: () => open,
            settle: async () => {
              open = false;
              settled.push(state.requests.filter(isUpdate).length);
            },
          };
        },
        signal(),
      );
      return { state, rotated, settled };
    };
    const written = await held();
    assert.ok(await written.rotated);
    assert.deepEqual(written.settled, [1], "settled once, after the write was sent");

    const stale = await held("before-write");
    assert.equal(await stale.rotated, undefined);
    assert.equal(stale.state.requests.some(isUpdate), false, "the stale write sends nothing");
    assert.deepEqual(stale.settled, [0]);

    const refused = await held("invalid");
    await assert.rejects(refused.rotated, refusedAs(undefined));
    assert.equal(refused.state.requests.some(isUpdate), false);
    assert.deepEqual(refused.settled, [0], "a refused write still ends the hold");
  });

  test("a Source Provider has its own name, and lends for at most 15 minutes where the App lends for an hour", async (t) => {
    const { state, client } = await wire(t);
    const { repository: _repository, ...base } = scope;
    const source = { ...base, credentialSource: "cs_fixture_token", nativeGit: "v1" } as const;
    const binding = new OpenShellPreparedGitProvider(client, source);
    const installation = { ...base, installationId: "42", nativeGit: "v1" } as const;
    assert.match(binding["provider"], /^oce-github-token-[a-f0-9]{32}$/);
    assert.match(
      new OpenShellPreparedGitProvider(client, installation)["provider"],
      /^oce-github-installation-[a-f0-9]{32}$/,
    );
    for (const widened of [
      { nativeGit: undefined },
      { installationId: "42" },
      { repository: "example/project" },
      { credentialSource: "sec_fixture_token" },
      { credentialSource: "cs_" },
      { apiOrigin: "https://github.example.test" },
    ]) {
      assert.throws(
        () =>
          new OpenShellPreparedGitProvider(client, {
            ...source,
            ...widened,
          } as unknown as OpenShellPreparedGitScope),
        OpenShellPreparedGitProviderError,
      );
    }
    const minutes = (count: number) => ({
      ...token(`minutes_${count}`),
      expiresAt: new Date(Date.now() + count * 60_000).toISOString(),
    });
    // The bound is checked before any request; a value within it goes on to the gateway.
    const reaches = async (provider: OpenShellPreparedGitProvider, count: number) => {
      const before = state.requests.length;
      const refused = await provider.prepare(minutes(count), signal()).then(
        () => false,
        (error: unknown) => refusedAs(undefined)(error) && state.requests.length === before,
      );
      return !refused;
    };
    assert.equal(await reaches(binding, 16), false, "a Source is not lent past 15 minutes");
    assert.equal(await reaches(binding, 15), true);
    assert.equal(
      await reaches(
        new OpenShellPreparedGitProvider(client, { ...installation, executionId: "app" }),
        50,
      ),
      true,
      "the App's installation token keeps its hour",
    );
  });

  test("prepared Git rejects credential and scope widening before provisioning", async (t) => {
    const { state, binding, client } = await wire(t);
    for (const invalid of [
      { ...token(), expiresAt: new Date(Date.now() + 7_200_000).toISOString() },
      { ...token(), value: "-----BEGIN PRIVATE KEY-----" },
      { ...token(), value: "openshell:resolve:env:NOT_A_TOKEN" },
    ]) {
      await assert.rejects(binding.prepare(invalid, signal()), /refused/);
    }
    for (const widened of [
      { binaries: [] },
      { repository: "example/../project" },
      { gitOrigin: "http://github.com" },
      { apiOrigin: "https://*.github.com" },
      { workspace: "" },
    ]) {
      assert.throws(
        () => new OpenShellPreparedGitProvider(client, { ...scope, ...widened }),
        OpenShellPreparedGitProviderError,
      );
    }
    assert.equal(state.requests.length, 0);
  });
}

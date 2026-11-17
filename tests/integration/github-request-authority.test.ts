import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import type {
  GitHubRequestView,
  PreparedGitHubInstallationUseRequest,
  PreparedGitHubRepositoryUseRequest,
  PreparedGitHubUseRequest,
  ProtectedRepositoryGitAuthority,
  RepositoryGitInstallationFence,
} from "../../packages/contracts/src/index.ts";
import {
  loadInstallationConfiguration,
  type InstallationRuntimeDrivers,
} from "../../apps/controller/src/composition/installation-config.ts";
import { bindRepositoryGitTransport } from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import { createRepositoryGitRequests } from "../../apps/controller/src/drivers/repo/github/access/protected-requests.ts";
import type { PostgresPool } from "../../packages/occ/src/index.ts";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { listen } from "../helpers/listen.ts";
import { onlineGitAllow, openShellOnlineGitWire } from "../helpers/openshell-online-git-wire.mjs";
import { invoke, token } from "../helpers/openshell-online-wire.mjs";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";

// One GitHub request decision for every sender. The bundled OpenShell request hook and an
// installed package's injector, which receives OCE's requests port from the Worker, are given
// the same requests and the same modelled authority; they must agree on every decision.
// The authority models the owner boundary only (use rows, one-draft allowance, withdrawal);
// postgres-external-protected-git covers the durable store through an installed package.

type Profile = "repository_git" | "github_repository" | "github_installation";
type Use =
  | PreparedGitHubUseRequest
  | PreparedGitHubInstallationUseRequest
  | PreparedGitHubRepositoryUseRequest;
type Request = {
  host: "github.com" | "api.github.com" | "gist.github.com";
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: string;
  headers?: [string, string][];
  body?: Buffer;
};

const secret = "ghs_" + "f".repeat(36);
const route: RepositoryGitInstallationFence = {
  revisionId: "execution-one",
  fence: 3,
  observed: { recipient: "fixture" },
};
const version = { preparationAttemptId: "prepared-one", materialVersion: "version-one" };
const ids = { sessionId: "session-one", providerInstanceId: "github-one", grantId: "grant-one" };
const repositories = [{ repositoryId: "42", repository: "example/project" }];
const pushRef = "refs/heads/review/task";

const packet = (value: string) =>
  Buffer.from((Buffer.byteLength(value) + 4).toString(16).padStart(4, "0") + value);
const push = (...refs: string[]) =>
  Buffer.concat([
    ...refs.map((ref, i) =>
      packet(`${"0".repeat(40)} ${"1".repeat(40)} ${ref}${i === 0 ? "\0report-status" : ""}\n`),
    ),
    Buffer.from("0000"),
  ]);
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const gitHeaders: [string, string][] = [
  ["user-agent", "git/2.55.0"],
  ["accept", "*/*"],
  ["accept-encoding", "deflate, gzip, br, zstd"],
  ["pragma", "no-cache"],
];
const gh: [string, string][] = [
  ["user-agent", "GitHub CLI 2.103.2"],
  ["accept", "application/vnd.github+json"],
  ["time-zone", "Etc/UTC"],
];
const discovery = (repository: string, service: string): Request => ({
  host: "github.com",
  method: "GET",
  path: `/${repository}.git/info/refs`,
  query: `service=${service}`,
  headers: [...gitHeaders, ["git-protocol", "version=2"]],
});
const pack = (repository: string, body: Buffer, service = "receive"): Request => ({
  host: "github.com",
  method: "POST",
  path: `/${repository}.git/git-${service}-pack`,
  headers: [
    ["user-agent", "git/2.55.0"],
    ["content-type", `application/x-git-${service}-pack-request`],
  ],
  body,
});
const fetchBody = Buffer.concat([packet(`want ${"1".repeat(40)}\n`), Buffer.from("0000")]);
const api = (method: Request["method"], path: string, body?: unknown, query = ""): Request => ({
  host: "api.github.com",
  method,
  path,
  query,
  headers:
    body === undefined
      ? gh.filter(([name]) => name !== "time-zone")
      : [...gh, ["content-type", "application/json; charset=utf-8"]],
  ...(body === undefined ? {} : { body: json(body) }),
});
const draft = (base = "main"): Request => ({
  host: "api.github.com",
  method: "POST",
  path: "/repos/example/project/pulls",
  headers: [
    ["user-agent", "GitHub CLI 2.103.2"],
    ["content-type", "application/json"],
  ],
  body: json({
    title: "Review task",
    head: "review/task",
    base,
    body: "Ready for review.",
    draft: true,
    maintainer_can_modify: false,
  }),
});

const gzipPush = (body: Buffer): Request => {
  const request = pack("example/project", body);
  return { ...request, headers: [...request.headers!, ["content-encoding", "gzip"]] };
};

/**
 * Expected decision per profile; each list runs in order against one fresh authority.
 * "allow", or the Agent's reason code and OCE's refusal ("code:refusal"). Both sides must also
 * name the same operation.
 */
const journeys: Record<Profile, [string, Request, string][]> = {
  repository_git: [
    ["fetch discovery", discovery("example/project", "git-upload-pack"), "allow"],
    ["push discovery", discovery("example/project", "git-receive-pack"), "allow"],
    ["fetch", pack("example/project", fetchBody, "upload"), "allow"],
    ["push to the granted ref", pack("example/project", push(pushRef)), "allow"],
    [
      "push to another ref",
      pack("example/project", push("refs/heads/main")),
      "request_not_allowed:ref_not_allowed",
    ],
    [
      "push that also updates another ref",
      pack("example/project", push(pushRef, "refs/heads/main")),
      "request_not_allowed:ref_not_allowed",
    ],
    [
      "push to a tag",
      pack("example/project", push("refs/tags/v1")),
      "request_not_allowed:ref_not_allowed",
    ],
    [
      "fetch from another repository",
      discovery("example/other", "git-upload-pack"),
      "request_not_allowed:route_unsupported",
    ],
    [
      "push to another host",
      { ...pack("example/project", push(pushRef)), host: "api.github.com" },
      "request_not_allowed:origin_mismatch",
    ],
    [
      "discovery with a body",
      { ...discovery("example/project", "git-upload-pack"), body: Buffer.from("0000") },
      "request_not_allowed:discovery_body",
    ],
    ["empty push", pack("example/project", Buffer.alloc(0)), "request_not_allowed:body_empty"],
    [
      "fetch over 1 MiB",
      pack("example/project", Buffer.concat([fetchBody, Buffer.alloc(1024 * 1024)]), "upload"),
      "request_not_allowed:body_too_large",
    ],
    ["compressed push", gzipPush(push(pushRef)), "request_not_allowed:encoding_unsupported"],
    // A repository grant admits only its draft create on the API.
    [
      "REST outside the grant",
      api("GET", "/repos/example/project"),
      "request_not_allowed:draft_rejected",
    ],
    ["draft with another base", draft("release"), "request_not_allowed:draft_rejected"],
    [
      "pull request that is not a draft",
      { ...draft(), body: json({ ...JSON.parse(draft().body!.toString()), draft: false }) },
      "request_not_allowed:draft_rejected",
    ],
    ["draft create", draft(), "allow"],
    ["second draft create", draft(), "draft_already_opened:draft_already_opened"],
  ],
  github_repository: [
    ["fetch discovery", discovery("example/project", "git-upload-pack"), "allow"],
    ["push to any ref", pack("example/project", push("refs/heads/feature")), "allow"],
    [
      "fetch from another repository",
      discovery("example/other", "git-upload-pack"),
      "request_not_allowed:route_unsupported",
    ],
    [
      "fetch from another host",
      { ...discovery("example/project", "git-upload-pack"), host: "gist.github.com" },
      "request_not_allowed:origin_mismatch",
    ],
    ["gh auth status discovery", api("GET", "/"), "allow"],
    ["gh api repository read", api("GET", "/repos/example/project"), "allow"],
    [
      "gh pr list --search",
      api("GET", "/search/issues", undefined, "q=repo%3Aexample%2Fproject+is%3Apr&per_page=30"),
      "allow",
    ],
    [
      "gh GraphQL query",
      api("POST", "/graphql", {
        query: 'query { repository(owner: "example", name: "project") { name } }',
      }),
      "allow",
    ],
    [
      "gh pr create (GraphQL mutation)",
      api("POST", "/graphql", {
        query:
          "mutation($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }",
        variables: { input: { draft: true } },
      }),
      "allow",
    ],
    [
      "GraphQL clone credential",
      api("POST", "/graphql", {
        query: 'query { repository(owner: "example", name: "project") { tempCloneToken } }',
      }),
      "request_not_allowed:route_unsupported",
    ],
    [
      "REST on another repository",
      api("GET", "/repos/example/other"),
      "request_not_allowed:route_unsupported",
    ],
    [
      "deploy key creation",
      api("POST", "/repos/example/project/keys", { title: "k", key: "ssh-ed25519 AAAA" }),
      "request_not_allowed:route_unsupported",
    ],
  ],
  github_installation: [
    ["fetch from any installed repository", discovery("example/other", "git-upload-pack"), "allow"],
    ["gh api repository read", api("GET", "/repos/example/other"), "allow"],
    [
      "runner registration token",
      // Without time-zone, so the runner rule (not the header rule) refuses it.
      {
        ...api("POST", "/repos/example/project/actions/runners/registration-token", {}),
        headers: [
          ...gh.filter(([name]) => name !== "time-zone"),
          ["content-type", "application/json; charset=utf-8"],
        ],
      },
      "request_not_allowed:route_unsupported",
    ],
    [
      "API body over 64 KiB",
      {
        ...api("POST", "/repos/example/other/issues", { title: "t", body: "x".repeat(65536) }),
        headers: [
          ...gh.filter(([name]) => name !== "time-zone"),
          ["content-type", "application/json"],
        ],
      },
      // The installation API's size bound refuses the route, not the body.
      "request_not_allowed:route_unsupported",
    ],
  ],
};

function materialFor(profile: Profile) {
  const common = {
    ...ids,
    ...version,
    value: secret,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    apiOrigin: "https://api.github.com",
  };
  return profile === "repository_git"
    ? {
        ...common,
        repositoryId: "42",
        repository: "example/project",
        pushRef,
        pullRequestBase: "main",
      }
    : profile === "github_repository"
      ? { ...common, scope: "github-repository" as const, installationId: "71", repositories }
      : { ...common, scope: "github-installation" as const, installationId: "71" };
}

/** The owner boundary: one use per decision, one draft per grant, then withdrawal. */
function modelledAuthority(profile: Profile) {
  const state = { withdrawn: false, materialWithdrawn: false, drafts: 0, uses: [] as Use[] };
  const material = materialFor(profile);
  const decide =
    (kind: "allow" | "permit") =>
    async (q: Use, installed: typeof version & { route?: RepositoryGitInstallationFence }) => {
      if (state.withdrawn) {
        return { kind: "denied" as const, reason: "access_withdrawn" as const };
      }
      if (q.operation === "create-draft-pull" && state.drafts++ > 0) {
        return { kind: "denied" as const, reason: "draft_already_opened" as const };
      }
      state.uses.push(q);
      const allow = onlineGitAllow(q, installed);
      const answer =
        kind === "allow"
          ? allow
          : { ...allow, kind: "permit" as const, replyBy: undefined, sendStartBy: allow.replyBy };
      return "scope" in q && q.scope === "github-installation"
        ? {
            ...answer,
            scope: q.scope,
            operation: q.operation,
            revisionId: installed.route!.revisionId,
            fence: installed.route!.fence,
          }
        : answer;
    };
  const port = (kind: "allow" | "permit", scope?: string) => ({
    readMaterial: async (observed: RepositoryGitInstallationFence) =>
      state.materialWithdrawn
        ? { absent: "withdrawn" as const }
        : observed.revisionId === route.revisionId &&
            observed.fence === route.fence &&
            ("scope" in material ? material.scope : undefined) === scope
          ? material
          : { absent: "unprepared" as const },
    authorize: decide(kind),
  });
  const mode = (kind: "allow" | "permit") => ({
    ...port(kind),
    githubRepository: port(kind, "github-repository"),
    githubInstallation: port(kind, "github-installation"),
  });
  const authority = {
    ...mode("permit"),
    online: mode("allow"),
    recipients: {
      observe: async () => route,
      beginInstall: async () => undefined,
      confirmInstall: async () => undefined,
    },
  } as unknown as ProtectedRepositoryGitAuthority;
  // The bundled route's binding for the same material and recipient.
  const { value: _value, expiresAt: _expiresAt, ...scope } = material;
  const binding = {
    sandboxId: "immutable-sandbox-id",
    bindingId: "binding_0123456789abcdefghijklmn",
    workspace: "team-workspace",
    executionId: route.revisionId,
    ...scope,
    installed: { ...version, route },
  };
  return { state, authority, binding, online: decide("allow") };
}

/** One side's decision: "allow" or "reasonCode:refusal", and the operation it named. */
type Decided = { outcome: string; operation?: string };

async function openShellRoute(t: TestContext, profile: Profile) {
  const owner = modelledAuthority(profile);
  const denials: { reason: string; reasonCode?: string; operation?: string }[] = [];
  const { client, keys } = await openShellOnlineGitWire(t, {
    budgetMs: 3000,
    lookupBinding: async () => owner.binding,
    authorizeOnlineRequest: owner.online,
    onDeny: (denial: (typeof denials)[number]) => denials.push(denial),
  });
  const bearer = token(keys, "supervisor", owner.binding.sandboxId);
  const decide = async (q: Request): Promise<Decided> => {
    const [denied, used] = [denials.length, owner.state.uses.length];
    const result = await invoke(
      client,
      "EvaluateHttpRequest",
      {
        phase: 1,
        middleware_name: "online-git",
        context: {
          sandbox_id: owner.binding.sandboxId,
          request_id: randomUUID(),
          workspace: owner.binding.workspace,
        },
        config: { fields: { binding_id: { stringValue: owner.binding.bindingId } } },
        target: {
          scheme: "https",
          host: q.host,
          port: 443,
          method: q.method,
          path: q.path,
          query: q.query ?? "",
        },
        body: q.body ?? Buffer.alloc(0),
        headers: (q.headers ?? []).map(([name, value]) => ({ name, value })),
      },
      bearer,
    );
    if (result.decision === 1) {
      assert.equal(denials.length, denied);
      assert.equal(owner.state.uses.length, used + 1);
      return { outcome: "allow", operation: owner.state.uses.at(-1)!.operation };
    }
    // The hook journals every refusal it decides; the wire layer adds none of its own here.
    assert.equal(denials.length, denied + 1, "OpenShell journals the refusal");
    const { reason, reasonCode, operation } = denials.at(-1)!;
    assert.equal(result.reason_code, reasonCode);
    return {
      outcome: (reasonCode ?? "deny") + ":" + reason,
      ...(operation === undefined ? {} : { operation }),
    };
  };
  return { owner, decide };
}

async function installedInjector(t: TestContext, profile: Profile) {
  const tls = await createTlsMaterial(t);
  const upstream: {
    method: string | undefined;
    url: string | undefined;
    host: string | undefined;
    authorization: string | undefined;
  }[] = [];
  const github = createServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
    await buffer(req);
    upstream.push({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      authorization: req.headers.authorization,
    });
    res.writeHead(req.url?.endsWith("/pulls") ? 201 : 200).end("{}");
  });
  const upstreamOrigin = "https://127.0.0.1:" + (await listen(t, github));
  const id = "request-injector-" + profile.replaceAll("_", "-");
  const { directory, entry } = await protectedDriverPackage(t, id, "request-sender");
  const base = createInstallationDriverConfiguration();
  const path = join(directory, "installation.yaml");
  await writeFile(
    path,
    JSON.stringify({
      ...base,
      presets: { includeDefaults: false },
      drivers: {
        ...base.drivers,
        sandbox: {
          id,
          package: id,
          configuration: {
            endpoint: "https://127.0.0.1:1",
            ca: tls.ca.toString(),
            certFile: tls.certFile,
            keyFile: tls.keyFile,
            upstreamOrigin,
            profile,
          },
        },
        credential_proxy: { id, configuration: {} },
      },
    }),
  );
  const loaded = (await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: path },
    packageRoot: directory,
  }))!;
  const driver = loaded.protectedDriver!;
  const { injector } = (await import(
    join(entry, "request-sender.mjs")
  )) as typeof import("../fixtures/driver-packages/protected-execution-driver/request-sender.ts");
  const owner = modelledAuthority(profile);
  // The Worker's own composition binds the package and hands it OCE's requests port.
  const bound = await bindRepositoryGitTransport(
    {
      repositoryGitDriver: driver,
      protectedDriver: driver,
    } as unknown as InstallationRuntimeDrivers,
    owner.authority,
    undefined as unknown as PostgresPool,
  );
  t.after(async () => {
    await bound?.close();
    await driver.close();
  });
  assert.equal(injector.bound, 1);
  assert.equal(injector.requestsSupplied, true);
  injector.route = route;
  const decide = async (q: Request): Promise<Decided> => {
    const before = upstream.length;
    const decided = injector.decisions.length;
    const { status, body } = await new Promise<{ status: number; body: Buffer }>(
      (resolve, reject) => {
        httpsRequest(
          injector.url + q.path + (q.query ? "?" + q.query : ""),
          {
            method: q.method,
            ca: tls.ca,
            agent: false,
            // Raw pairs keep a repeated name repeated, as a client may send it. A GET body
            // needs its length, or the client sends it unframed.
            headers: [
              ["host", q.host],
              ["authorization", "Bearer " + injector.marker],
              ...(q.headers ?? []),
              ...(q.body && q.method === "GET" ? [["content-length", String(q.body.length)]] : []),
            ].flat(),
          },
          (response) =>
            void buffer(response).then(
              (body) => resolve({ status: response.statusCode!, body }),
              reject,
            ),
        )
          .once("error", reject)
          .end(q.body);
      },
    );
    assert.equal(injector.decisions.length, decided + 1, "the injector asked OCE once");
    const decision = injector.decisions.at(-1) as {
      kind: string;
      refusal?: string;
      reasonCode?: string;
      operation?: string;
    };
    const named = decision.operation === undefined ? {} : { operation: decision.operation };
    if (status === 403) {
      assert.equal(upstream.length, before, "a refused request never reaches GitHub");
      const { reason_code } = JSON.parse(body.toString()) as { reason_code: string };
      assert.equal(reason_code, decision.reasonCode ?? "denied");
      return { outcome: (decision.reasonCode ?? "deny") + ":" + decision.refusal, ...named };
    }
    assert.ok(status === 200 || status === 201, `unexpected status ${status}`);
    const sent = upstream.at(-1)!;
    assert.equal(upstream.length, before + 1);
    assert.equal(sent.host, q.host);
    // The one injected header carries the installation token: Basic for Git, Bearer for the API.
    assert.equal(
      sent.authorization,
      q.host === "github.com"
        ? "Basic " + Buffer.from("x-access-token:" + secret).toString("base64")
        : "Bearer " + secret,
    );
    return { outcome: "allow", ...named };
  };
  return { owner, decide, injector, upstream };
}

for (const profile of Object.keys(journeys) as Profile[]) {
  test(`${profile}: the installed injector and the bundled OpenShell route decide alike`, async (t) => {
    const bundled = await openShellRoute(t, profile);
    const installed = await installedInjector(t, profile);
    for (const [name, request, expected] of journeys[profile]) {
      const openShell = await bundled.decide(request);
      assert.equal(openShell.outcome, expected, `OpenShell: ${name}`);
      // The same refusal, reason code and operation, not only the Agent's reason code.
      assert.deepEqual(await installed.decide(request), openShell, `installed: ${name}`);
    }
    // Both recorded the same operations, in the same order, for the same grant.
    const used = (uses: Use[]) =>
      uses.map((q) => [q.operation, "pushRef" in q ? q.pushRef : undefined, "pull" in q]);
    assert.deepEqual(used(installed.owner.state.uses), used(bundled.owner.state.uses));
    assert.ok(installed.owner.state.uses.every(({ deadlineAt }) => Date.parse(deadlineAt) > 0));

    // Withdrawal: the next request is refused before GitHub on both routes.
    const next = journeys[profile][0]![1];
    bundled.owner.state.withdrawn = true;
    installed.owner.state.withdrawn = true;
    const withdrawn = await bundled.decide(next);
    assert.equal(withdrawn.outcome, "access_withdrawn:session_closed");
    assert.deepEqual(await installed.decide(next), withdrawn);
    // An installed sender also reads material per request; withdrawn material is refused
    // alike, before classification, so it names no operation.
    installed.owner.state.withdrawn = false;
    installed.owner.state.materialWithdrawn = true;
    assert.deepEqual(await installed.decide(next), { outcome: "access_withdrawn:session_closed" });
  });
}

test("the requests port refuses a request an injector must not forward", async (t) => {
  const bundled = await openShellRoute(t, "repository_git");
  const installed = await installedInjector(t, "repository_git");
  const granted = pack("example/project", push(pushRef));
  // Repeated or unknown headers are refused, never interpreted, on both routes.
  for (const headers of [
    [...granted.headers!, ["user-agent", "git/2.55.0"]],
    [...granted.headers!, ["x-forwarded-for", "10.0.0.1"]],
  ] as [string, string][][]) {
    const openShell = await bundled.decide({ ...granted, headers });
    assert.equal(openShell.outcome, "request_not_allowed:request_invalid");
    assert.deepEqual(await installed.decide({ ...granted, headers }), openShell);
  }
  // A credential-shaped header never reaches OCE's classifier from the bundled supervisor, so
  // only the installed side can send one; its view bounds refuse it.
  assert.deepEqual(
    await installed.decide({
      ...granted,
      headers: [...granted.headers!, ["proxy-authorization", "Basic eA=="]],
    }),
    { outcome: "request_not_allowed:request_invalid" },
  );
  assert.deepEqual(await installed.decide(granted), await bundled.decide(granted));
  assert.equal(installed.owner.state.uses.length, 1, "only the admitted request records a use");
});

/** The port's own guards against a scripted authority: no HTTP, no package, one call each. */
function scriptedPort(
  profile: Profile,
  script: {
    readonly material?: (material: ReturnType<typeof materialFor>) => unknown;
    readonly read?: () => void;
    readonly answer?: (allow: Record<string, unknown>) => unknown;
    readonly subPorts?: false;
  } = {},
) {
  const calls = { reads: 0, uses: [] as Use[] };
  const material = materialFor(profile);
  const port = (kind: "allow" | "permit", scope?: string) => ({
    readMaterial: async (observed: RepositoryGitInstallationFence) => {
      calls.reads++;
      script.read?.();
      if (observed.revisionId !== route.revisionId || observed.fence !== route.fence) {
        return { absent: "unprepared" as const };
      }
      if (script.material) {
        return script.material(material);
      }
      return ("scope" in material ? material.scope : undefined) === scope
        ? material
        : { absent: "unprepared" as const };
    },
    authorize: async (
      q: Use,
      installed: typeof version & { route: RepositoryGitInstallationFence },
    ) => {
      calls.uses.push(q);
      const allow = onlineGitAllow(q, installed);
      const answer: Record<string, unknown> =
        kind === "allow"
          ? { ...allow }
          : { ...allow, kind: "permit", replyBy: undefined, sendStartBy: allow.replyBy };
      if ("scope" in q && q.scope === "github-installation") {
        Object.assign(answer, {
          scope: q.scope,
          operation: q.operation,
          revisionId: installed.route.revisionId,
          fence: installed.route.fence,
        });
      }
      return script.answer ? script.answer(answer) : answer;
    },
  });
  const mode = (kind: "allow" | "permit") => ({
    ...port(kind),
    ...(script.subPorts === false
      ? {}
      : {
          githubRepository: port(kind, "github-repository"),
          githubInstallation: port(kind, "github-installation"),
        }),
  });
  const authority = {
    ...mode("permit"),
    online: mode("allow"),
  } as unknown as ProtectedRepositoryGitAuthority;
  return { calls, requests: createRepositoryGitRequests(authority) };
}

const viewOf = (q: Request): GitHubRequestView => ({
  target: { host: q.host, port: 443, method: q.method, path: q.path, query: q.query ?? "" },
  headers: q.headers ?? [],
  body: q.body ?? Buffer.alloc(0),
});

const refused = (refusal: string, reasonCode?: string, operation?: string) => ({
  kind: "refused",
  refusal,
  ...(reasonCode === undefined ? {} : { reasonCode }),
  ...(operation === undefined ? {} : { operation }),
});

test("the requests port refuses at each of its own guards", async (t) => {
  const granted = pack("example/project", push(pushRef));
  const installationRead = api("GET", "/repos/example/other");
  const pushOf = (bytes: number) => {
    const commands = push(pushRef);
    return pack(
      "example/project",
      Buffer.concat([commands, Buffer.alloc(bytes - commands.length)]),
    );
  };
  const withUserAgent = (length: number): Request => ({
    ...granted,
    headers: [["user-agent", "u".repeat(length)], ...granted.headers!.slice(1)],
  });
  const headerBytes = granted.headers!.slice(1).reduce((n, [k, v]) => n + k.length + v.length, 0);
  const past = new Date(Date.now() - 60_000).toISOString();
  const controller = () => new AbortController();
  type Row = {
    readonly name: string;
    readonly profile?: Profile;
    readonly script?: Parameters<typeof scriptedPort>[1];
    readonly request?: Request;
    readonly input?: (input: Record<string, unknown>) => unknown;
    readonly signal?: AbortController;
    readonly expected: Record<string, unknown>;
    readonly reads: number;
    readonly uses: number;
  };
  const abortDuringRead = controller();
  const abortDuringAuthorize = controller();
  const rows: Row[] = [
    {
      name: "a current request",
      expected: { kind: "allow", operation: "receive-pack" },
      reads: 1,
      uses: 1,
    },
    // Material
    {
      name: "expired material",
      script: { material: (m) => ({ ...m, expiresAt: past }) },
      expected: refused("material_unavailable", "route_not_ready"),
      reads: 1,
      uses: 0,
    },
    {
      name: "installation material for a repository grant",
      script: { material: (m) => ({ ...m, scope: "github-installation", installationId: "71" }) },
      expected: refused("material_unavailable", "route_not_ready"),
      reads: 1,
      uses: 0,
    },
    {
      name: "repository material for an installation grant",
      profile: "github_installation",
      request: installationRead,
      script: { material: (m) => ({ ...m, scope: "github-repository", repositories }) },
      expected: refused("material_unavailable", "route_not_ready"),
      reads: 1,
      uses: 0,
    },
    {
      name: "unprepared material",
      script: { material: () => ({ absent: "unprepared" }) },
      expected: refused("material_unavailable", "route_not_ready"),
      reads: 1,
      uses: 0,
    },
    {
      name: "a failed material read",
      script: {
        material: () => {
          throw new Error("owner unavailable");
        },
      },
      expected: refused("material_unavailable", "route_not_ready"),
      reads: 1,
      uses: 0,
    },
    {
      name: "no installation port",
      profile: "github_installation",
      request: installationRead,
      script: { subPorts: false },
      expected: refused("material_unavailable", "route_not_ready"),
      reads: 0,
      uses: 0,
    },
    {
      name: "material outside a valid binding",
      script: { material: (m) => ({ ...m, pushRef: "refs/heads/*" }) },
      expected: refused("binding_mismatch"),
      reads: 1,
      uses: 0,
    },
    // The owner's answer
    ...(
      [
        ["scope", { scope: "github-repository" }],
        ["operation", { operation: "upload-pack" }],
        ["recipient", { revisionId: "execution-two" }],
        ["fence", { fence: route.fence + 1 }],
      ] as const
    ).map(([field, change]) => ({
      name: `an installation answer for another ${field}`,
      profile: "github_installation" as const,
      request: installationRead,
      script: { answer: (a: Record<string, unknown>) => ({ ...a, ...change }) },
      expected: refused("approval_denied", "route_not_ready", "github-rest"),
      reads: 1,
      uses: 1,
    })),
    {
      name: "an allow already past its send-by",
      script: { answer: (a) => ({ ...a, replyBy: new Date(Date.now() - 1000).toISOString() }) },
      expected: refused("approval_denied", "route_not_ready", "receive-pack"),
      reads: 1,
      uses: 1,
    },
    // The caller's input
    ...(
      [
        ["a route without a revision", { route: { ...route, revisionId: 7 } }],
        ["a route without a numeric fence", { route: { ...route, fence: "3" } }],
        ["no route", { route: null }],
        ["an unknown profile", { profile: "git_read" }],
        ["an unparsable deadline", { deadlineAt: "soon" }],
        ["a past deadline", { deadlineAt: past }],
        [
          "a deadline over 30 seconds ahead",
          { deadlineAt: new Date(Date.now() + 31_000).toISOString() },
        ],
        ["no request", { request: undefined }],
        ["no signal", { signal: undefined }],
        ["headers that are not pairs", { request: { ...viewOf(granted), headers: {} } }],
        ["a body that is not bytes", { request: { ...viewOf(granted), body: "0000" } }],
      ] as const
    ).map(([name, change]) => ({
      name,
      input: (input: Record<string, unknown>) => ({ ...input, ...change }),
      expected: refused("request_invalid", "request_not_allowed"),
      reads: 0,
      uses: 0,
    })),
    {
      name: "no input at all",
      input: () => undefined,
      expected: refused("request_invalid", "request_not_allowed"),
      reads: 0,
      uses: 0,
    },
    {
      name: "a deadline 29 seconds ahead",
      input: (input) => ({ ...input, deadlineAt: new Date(Date.now() + 29_000).toISOString() }),
      expected: { kind: "allow", operation: "receive-pack" },
      reads: 1,
      uses: 1,
    },
    // The view bounds, at and past each limit
    {
      name: "a 4 MiB push",
      request: pushOf(4 * 1024 * 1024),
      expected: { kind: "allow", operation: "receive-pack" },
      reads: 1,
      uses: 1,
    },
    {
      name: "a push one byte over 4 MiB",
      request: pushOf(4 * 1024 * 1024 + 1),
      expected: refused("request_invalid", "request_not_allowed"),
      reads: 0,
      uses: 0,
    },
    {
      name: "64 KiB of headers",
      request: withUserAgent(64 * 1024 - headerBytes - "user-agent".length),
      expected: { kind: "allow", operation: "receive-pack" },
      reads: 1,
      uses: 1,
    },
    {
      name: "headers one byte over 64 KiB",
      request: withUserAgent(64 * 1024 - headerBytes - "user-agent".length + 1),
      expected: refused("request_invalid", "request_not_allowed"),
      reads: 0,
      uses: 0,
    },
    {
      name: "129 headers",
      request: {
        ...granted,
        headers: Array.from({ length: 129 }, (_, i) => [`x-h${i}`, "v"] as [string, string]),
      },
      expected: refused("request_invalid", "request_not_allowed"),
      reads: 0,
      uses: 0,
    },
    ...["authorization", "proxy-authorization", "host", "transfer-encoding"].map((name) => ({
      name: `a ${name} header`,
      request: { ...granted, headers: [...granted.headers!, [name, "x"] as [string, string]] },
      expected: refused("request_invalid", "request_not_allowed"),
      reads: 0,
      uses: 0,
    })),
    // Cancellation at each await
    {
      name: "a signal aborted before the call",
      input: (input) => ({ ...input, signal: AbortSignal.abort() }),
      expected: refused("aborted", "route_not_ready"),
      reads: 0,
      uses: 0,
    },
    {
      name: "an abort during the material read",
      signal: abortDuringRead,
      script: { read: () => abortDuringRead.abort() },
      expected: refused("aborted", "route_not_ready", "receive-pack"),
      reads: 1,
      uses: 0,
    },
    {
      name: "an abort before the owner's allow arrives",
      signal: abortDuringAuthorize,
      script: {
        answer: (a) => {
          abortDuringAuthorize.abort();
          return a;
        },
      },
      expected: refused("approval_denied", "route_not_ready", "receive-pack"),
      reads: 1,
      uses: 1,
    },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      const { calls, requests } = scriptedPort(row.profile ?? "repository_git", row.script);
      const input = {
        route,
        profile: row.profile ?? "repository_git",
        request: viewOf(row.request ?? granted),
        signal: row.signal?.signal ?? AbortSignal.timeout(5000),
      };
      const decision = await requests.authorize(
        (row.input ? row.input(input) : input) as Parameters<typeof requests.authorize>[0],
      );
      const { credential, sendBy, exchangeId, ...rest } = decision as Record<string, unknown>;
      assert.deepEqual(rest, row.expected);
      assert.equal(credential !== undefined, decision.kind === "allow");
      // The decision names the use OCE asked its owner to record, if it asked.
      assert.equal(exchangeId, calls.uses.at(-1)?.exchangeId);
      assert.equal(sendBy !== undefined, decision.kind === "allow");
      assert.deepEqual([calls.reads, calls.uses.length], [row.reads, row.uses]);
    });
  }
});

test("the requests port digests the whole classified view and nothing else", async () => {
  const { calls, requests } = scriptedPort("repository_git");
  const granted = viewOf(pack("example/project", push(pushRef)));
  const digest = async (request: GitHubRequestView) => {
    const decision = await requests.authorize({
      route,
      profile: "repository_git",
      request,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(decision.kind, "allow");
    return calls.uses.at(-1)!.requestDigestSha256;
  };
  const base = await digest(granted);
  assert.equal(await digest(granted), base, "the same view, the same digest");
  const { host, port, method, path, query } = granted.target;
  // Key order and keys the view does not define do not change it.
  assert.equal(
    await digest({
      ...granted,
      target: { query, path, method, port, host, extra: "x" } as GitHubRequestView["target"],
    }),
    base,
  );
  for (const [name, changed] of [
    ["body", { ...granted, body: Buffer.concat([granted.body, Buffer.from("PACK")]) }],
    [
      "header value",
      { ...granted, headers: [["user-agent", "git/2.56.0"], ...granted.headers.slice(1)] },
    ],
  ] as const) {
    assert.notEqual(await digest(changed as GitHubRequestView), base, name);
  }
});

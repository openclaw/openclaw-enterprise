import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import type {
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
  host: "github.com" | "api.github.com";
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

/** Expected decision per profile; each list runs in order against one fresh authority. */
const journeys: Record<Profile, [string, Request, string][]> = {
  repository_git: [
    ["fetch discovery", discovery("example/project", "git-upload-pack"), "allow"],
    ["push discovery", discovery("example/project", "git-receive-pack"), "allow"],
    ["fetch", pack("example/project", fetchBody, "upload"), "allow"],
    ["push to the granted ref", pack("example/project", push(pushRef)), "allow"],
    [
      "push to another ref",
      pack("example/project", push("refs/heads/main")),
      "request_not_allowed",
    ],
    [
      "push that also updates another ref",
      pack("example/project", push(pushRef, "refs/heads/main")),
      "request_not_allowed",
    ],
    ["push to a tag", pack("example/project", push("refs/tags/v1")), "request_not_allowed"],
    [
      "fetch from another repository",
      discovery("example/other", "git-upload-pack"),
      "request_not_allowed",
    ],
    ["REST outside the grant", api("GET", "/repos/example/project"), "request_not_allowed"],
    ["draft with another base", draft("release"), "request_not_allowed"],
    ["draft create", draft(), "allow"],
    ["second draft create", draft(), "draft_already_opened"],
  ],
  github_repository: [
    ["fetch discovery", discovery("example/project", "git-upload-pack"), "allow"],
    ["push to any ref", pack("example/project", push("refs/heads/feature")), "allow"],
    [
      "fetch from another repository",
      discovery("example/other", "git-upload-pack"),
      "request_not_allowed",
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
      "request_not_allowed",
    ],
    ["REST on another repository", api("GET", "/repos/example/other"), "request_not_allowed"],
    [
      "deploy key creation",
      api("POST", "/repos/example/project/keys", { title: "k", key: "ssh-ed25519 AAAA" }),
      "request_not_allowed",
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
      "request_not_allowed",
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

async function openShellRoute(t: TestContext, profile: Profile) {
  const owner = modelledAuthority(profile);
  const { client, keys } = await openShellOnlineGitWire(t, {
    budgetMs: 3000,
    lookupBinding: async () => owner.binding,
    authorizeOnlineRequest: owner.online,
  });
  const bearer = token(keys, "supervisor", owner.binding.sandboxId);
  const decide = async (q: Request) => {
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
    return result.decision === 1 ? "allow" : (result.reason_code ?? "deny");
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
            authorization: "online-request",
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
  const decide = async (q: Request) => {
    const before = upstream.length;
    const { status, body } = await new Promise<{ status: number; body: Buffer }>(
      (resolve, reject) => {
        httpsRequest(
          injector.url + q.path + (q.query ? "?" + q.query : ""),
          {
            method: q.method,
            ca: tls.ca,
            agent: false,
            // Raw pairs keep a repeated name repeated, as a client may send it.
            headers: [
              ["host", q.host],
              ["authorization", "Bearer " + injector.marker],
              ...(q.headers ?? []),
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
    if (status === 403) {
      assert.equal(upstream.length, before, "a refused request never reaches GitHub");
      const { reason_code } = JSON.parse(body.toString()) as { reason_code: string };
      return reason_code === "denied" ? "deny" : reason_code;
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
    return "allow";
  };
  return { owner, decide, injector, upstream };
}

for (const profile of Object.keys(journeys) as Profile[]) {
  test(`${profile}: the installed injector and the bundled OpenShell route decide alike`, async (t) => {
    const bundled = await openShellRoute(t, profile);
    const installed = await installedInjector(t, profile);
    for (const [name, request, expected] of journeys[profile]) {
      assert.equal(await bundled.decide(request), expected, `OpenShell: ${name}`);
      assert.equal(await installed.decide(request), expected, `installed: ${name}`);
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
    assert.equal(await bundled.decide(next), "access_withdrawn");
    assert.equal(await installed.decide(next), "access_withdrawn");
    // An installed sender also reads material per request; withdrawn material is refused alike.
    installed.owner.state.withdrawn = false;
    installed.owner.state.materialWithdrawn = true;
    assert.equal(await installed.decide(next), "access_withdrawn");
    assert.deepEqual(
      (installed.injector.decisions.at(-1) as { refusal?: string }).refusal,
      "session_closed",
    );
  });
}

test("the requests port refuses a request an injector must not forward", async (t) => {
  const installed = await installedInjector(t, "repository_git");
  const granted = pack("example/project", push(pushRef));
  // Repeated, unknown or credential-shaped headers are refused, never interpreted.
  for (const headers of [
    [...granted.headers!, ["user-agent", "git/2.55.0"]],
    [...granted.headers!, ["x-forwarded-for", "10.0.0.1"]],
    [...granted.headers!, ["proxy-authorization", "Basic eA=="]],
  ] as [string, string][][]) {
    assert.equal(await installed.decide({ ...granted, headers }), "request_not_allowed");
  }
  assert.equal(await installed.decide(granted), "allow");
  assert.equal(installed.owner.state.uses.length, 1, "only the admitted request records a use");
});

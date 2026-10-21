import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, get, request, type ServerOptions } from "node:https";
import { json } from "node:stream/consumers";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRevision,
  ComputeRevisionContext,
  ComputeDriver,
  RepositoryGitDeliveryProfile,
  RepositoryGitSendPermit,
} from "../../packages/contracts/src/index.ts";
import {
  loadInstallationConfiguration,
  readPublicCaBundle,
} from "../../apps/controller/src/composition/installation-config.ts";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import {
  bindRepositoryGitTransport,
  repositoryGitAuthority,
} from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  cleanEnvironment,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { createBackendController } from "../helpers/postgres-backend-state.mjs";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { standingGitOrigin } from "../helpers/prepared-standing-git-peer.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import { installationOrigin } from "../fixtures/driver-packages/protected-execution-driver/installation-origin.ts";

// Production package selection, OCC deployment, worker and custody. The external package,
// its workload, Kubernetes placement, GitHub and the private Git origin are controlled locally.
const journeyOptions = { ...requiresPostgres, timeout: 150_000 };
test(
  "an installed external Driver fetches private Git across rotation and receives the next fetch after withdrawal",
  journeyOptions,
  externalGitJourney("repository"),
);
test(
  "an installed external Driver uses an explicit GitHub installation for private Git fetch, push, REST and GraphQL until withdrawal",
  journeyOptions,
  externalGitJourney("installation"),
);

test(
  "an online sender uses the admitted GitHub installation for real Git and API requests until withdrawal",
  journeyOptions,
  externalGitJourney("online-installation"),
);

function repositoryConfiguration(input: {
  backendId: string;
  registryPath: string;
  privateKeyPath: string;
  custodyKeyPath: string;
  id: string;
  sandbox: Record<string, unknown>;
  issuerCaPath: string;
  apiOrigin: string;
}) {
  const base = createInstallationDriverConfiguration();
  return {
    ...base,
    presets: { includeDefaults: false },
    backend: [
      {
        id: input.backendId,
        type: "github",
        configuration: { registryPath: input.registryPath },
        drivers: { repo: input.backendId },
      },
    ],
    repository: {
      id: input.backendId,
      configuration: { sessionDurationSeconds: 180 },
      preparedGitHub: {
        privateKeyPath: input.privateKeyPath,
        custodyKeyPath: input.custodyKeyPath,
        issuerCaPath: input.issuerCaPath,
        apiOrigin: input.apiOrigin,
      },
    },
    drivers: {
      ...base.drivers,
      sandbox: { id: input.id, package: input.id, configuration: input.sandbox },
      credential_proxy: { id: input.id, configuration: {} },
    },
  };
}

test("production composition separates repository policy from protected and explicitly selected native senders", async (t) => {
  const namespaceId = "composition-policy";
  const origin = await standingGitOrigin(t, namespaceId, 300_000);
  const id = "cedar-composition-fixture";
  const { directory } = await protectedDriverPackage(t, id, "repository-git");
  const registryPath = join(directory, "registry.json");
  const registry = {
    ...origin.registry,
    repositories: origin.registry.repositories.map((repository) => ({
      ...repository,
      namespaces: repository.namespaces.map((policy) => ({
        ...policy,
        transport: "git-and-draft-pr",
        pullRequestBase: "main",
        draftPullLimit: "one-per-grant",
      })),
    })),
  };
  await writeFile(registryPath, JSON.stringify(registry));
  const path = join(directory, "installation.json");
  const configuration = repositoryConfiguration({
    ...origin,
    id,
    registryPath,
    issuerCaPath: origin.tls.certFile,
    apiOrigin: origin.gh.origin,
    sandbox: {
      origin: origin.origin.origin,
      peerOrigin: "https://127.0.0.1:1",
      capabilityOrigin: "https://127.0.0.1:2",
      certFile: origin.tls.certFile,
      releaseKey: "unused-before-release",
    },
  });
  const load = async (value: unknown) => {
    await writeFile(path, JSON.stringify(value));
    return (await loadInstallationConfiguration({
      mode: "production",
      packageRoot: directory,
      environment: { OCC_CONFIG_PATH: path },
    }))!;
  };
  const protectedGit = await load(configuration);
  const policy = protectedGit.repositoryPolicy!;
  assert.equal((await policy.listOptions({ namespaceId })).options.length, 1);
  const binding = policy.resolve({
    namespaceId,
    bindings: [{ repositoryRef: "source", profile: "git-write" }],
  }).bindings[0]!;
  const scope = policy.standingApprovalScope!({ namespaceId, binding })!;
  assert.deepEqual(scope.pushRefAllowlist, ["refs/heads/review"]);
  assert.equal(scope.pullRequestBase, "main");
  assert.equal(scope.draftPullLimit, "one-per-grant");
  await assert.rejects(
    load({
      ...configuration,
      repository: {
        ...configuration.repository,
        configuration: { sessionDurationSeconds: 180, controlSocket: "/unselected/control.sock" },
      },
    }),
    /repository.configuration.*controlSocket/,
  );
  await assert.rejects(
    load({
      ...configuration,
      repository: {
        ...configuration.repository,
        nativeSender: {
          controlSocket: "/unselected/control.sock",
          publicCaPath: origin.tls.certFile,
        },
      },
    }),
    /cannot fall back/,
  );
  const { sandbox: _sandbox, credential_proxy: _proxy, ...nativeDrivers } = configuration.drivers;
  await assert.rejects(
    load({ ...configuration, drivers: nativeDrivers }),
    /explicitly selected protected/,
  );
  const native = await load({
    ...configuration,
    repository: {
      ...configuration.repository,
      nativeSender: {
        controlSocket: "/unselected/control.sock",
        publicCaPath: origin.tls.certFile,
      },
    },
    drivers: {
      ...nativeDrivers,
      compute: {
        ...nativeDrivers.compute,
        configuration: {
          ...nativeDrivers.compute.configuration,
          network: {
            ...nativeDrivers.compute.configuration.network,
            repositoryCredentials: {
              namespace: "occ-system",
              podLabels: { app: "repository" },
              port: 8443,
            },
          },
        },
      },
    },
  });
  assert.ok(native.nativeRepositorySender);
  assert.equal(native.repositoryGitDriver, undefined);
  assert.equal(native.installation.drivers.repo, undefined);
  assert.deepEqual(
    native.repositoryPolicy!.resolve({
      namespaceId,
      bindings: [{ repositoryRef: "source", profile: "git-write" }],
    }).bindings,
    [binding],
  );
  assert.deepEqual(
    native.repositoryPolicy!.standingApprovalScope!({ namespaceId, binding }),
    scope,
  );
  // Installation-wide authority is never available through a native session, even with a prepared provider.
  await assert.rejects(
    native.nativeRepositorySender.open(
      {
        namespaceId,
        admissionId: "composition-only",
        binding: { ...binding, profile: "github-installation" },
        durationSeconds: 180,
        deadlineWallMs: Date.now() + 180_000,
      },
      t.signal,
    ),
    /requires the protected Credential Proxy/,
  );
});

// Public discovery has its own listener. It receives no sender, installation or protected authority.
function createCapabilityPeer(
  tls: ServerOptions,
  profile: RepositoryGitDeliveryProfile,
  online: boolean,
) {
  const capability = { profile, online, requests: 0 };
  const server = createServer(tls, (req, res) => {
    if (req.method !== "GET" || req.url !== "/capability") {
      res.writeHead(404).end();
      return;
    }
    capability.requests++;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          capability.online
            ? { profile: capability.profile, authorization: "online-request" }
            : capability.profile,
        ),
      );
  });
  return { capability, server };
}

function externalGitJourney(scope: "repository" | "installation" | "online-installation") {
  return async (t: TestContext) => {
    const f = await standingExecutionPlatform(t, import.meta.url);
    const { id: namespaceId } = f.namespace;
    const online = scope === "online-installation";
    const broad = scope !== "repository" ? await installationOrigin(t, namespaceId) : undefined;
    const { registry, backendId, origin, gh, tls, privateKeyPath, custodyKeyPath } =
      broad ?? (await standingGitOrigin(t, namespaceId, 300_000));
    const installationApiOrigin = broad?.gh.origin;
    const id = "cedar-git-fixture";
    const { directory, entry } = await protectedDriverPackage(t, id, "repository-git");
    const cedar = (await import(
      join(entry, "repository-git.mjs")
    )) as typeof import("../fixtures/driver-packages/protected-execution-driver/repository-git.ts");
    const registryPath = join(directory, "registry.json");
    await writeFile(registryPath, JSON.stringify(registry));
    const path = join(directory, "installation.json");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { certFile } = tls;
    const peerOrigin = await listen(t, cedar.createCounterpart(tls));
    const { capability, server } = createCapabilityPeer(
      tls,
      broad ? "github_installation" : "repository_git",
      online,
    );
    const capabilityOrigin = await listen(t, server);
    const releaseKey = publicKey.export({ format: "pem", type: "spki" }).toString();
    await writeFile(
      path,
      JSON.stringify(
        repositoryConfiguration({
          backendId,
          registryPath,
          privateKeyPath,
          custodyKeyPath,
          id,
          sandbox: {
            origin: origin.origin,
            peerOrigin,
            capabilityOrigin,
            certFile,
            releaseKey,
            installationApiOrigin,
          },
          issuerCaPath: certFile,
          apiOrigin: gh.origin,
        }),
      ),
    );
    // Production loads this package independently in the API and worker processes. Use separate
    // installed copies here, with the same durable identity and discovery origin; only the worker binds protected authority.
    const load = (packageRoot: string) =>
      loadInstallationConfiguration({
        mode: "production",
        packageRoot,
        environment: { OCC_CONFIG_PATH: path },
      });
    const apiPackage = await protectedDriverPackage(t, id, "repository-git");
    const apiDrivers = (await load(apiPackage.directory))!;
    const drivers = (await load(directory))!;
    const { repositoryOwner, repositoryRegistry, repositoryGitDriver: owner } = drivers;
    assert.ok(owner && repositoryOwner && repositoryRegistry && drivers.preparedRepositoryGit);
    assert.equal(repositoryOwner.controlSocket, undefined);
    assert.equal(drivers.installation.drivers.repo, undefined);
    assert.equal(drivers.nativeRepositorySender, undefined);
    assert.equal("open" in drivers.repositoryPolicy!, false);
    assert.equal(drivers.openShellGit, undefined);
    const apiOwner = apiDrivers.repositoryGitDriver!;
    assert.notEqual(apiOwner, owner);
    assert.deepEqual(apiOwner.ref, owner.ref);
    const kube = apiDrivers.computeDriver;
    const release = new ProtectedExecutionDriver(owner);
    // Use the worker's selected authority, configured trust and sender binding. Control only the
    // maintenance schedule so we can withdraw while the replacement credential is still usable.
    const { issuerCaPath, ...preparedConfig } = drivers.preparedRepositoryGit;
    const prepared = await startPreparedGitHubGitOwner({
      ...repositoryOwner,
      ...preparedConfig,
      ca: Buffer.from(await readPublicCaBundle(issuerCaPath!)),
      pool: f.observerPool,
      registry: repositoryRegistry,
      ...repositoryGitAuthority(drivers),
      startWorker: false,
    });
    t.after(() => prepared.close());
    const transport = await bindRepositoryGitTransport(drivers, prepared, f.observerPool);
    assert.ok(transport);
    t.after(() => transport.close());
    const { peer } = cedar;

    // The worker still opens and proves a real standing session. Model and cluster availability
    // are outside this test; only workload preparation and the Namespace observation are controlled.
    const namespace = { ...f.namespace, status: "ready" as const };
    const compute: ComputeDriver = {
      ...f.compute,
      capability: "compute",
      async stopRevision() {},
      id: kube.id,
      implementation: kube.implementation,
      validateHarnessAuth: kube.validateHarnessAuth!.bind(kube),
      validateExecutionAdmission: kube.validateExecutionAdmission!.bind(kube),
      validateRepositoryCredentials: kube.validateRepositoryCredentials!.bind(kube),
      async prepareRevision(revision: AgentRevision, custody: ComputeRevisionContext) {
        const { egressPlan: plan } = revision;
        assert.ok(plan?.repositoryGit && custody.currentEgressInstallation);
        const context = { plan, revision, namespace, signal: t.signal };
        if (broad) {
          capability.profile = "repository_git";
          await assert.rejects(
            release.configure(context),
            /no longer supports GitHub installation access/,
          );
          assert.equal(
            gh.issuesOfTokens.length,
            0,
            "a repository-only sender cannot prepare a broad token",
          );
          capability.profile = "github_installation";
          if (online) {
            capability.online = false;
            await assert.rejects(release.configure(context), /admitted sender guarantee/);
            assert.equal(gh.issuesOfTokens.length, 0, "cannot downgrade v5 before issuance");
            capability.online = true;
          }
        }
        const wiring = await release.configure(context);
        assert.equal(
          await release.enroll(
            context,
            wiring,
            custody,
            async () => true,
            async () => ({
              ...context,
              kubernetes: undefined,
              transportToken: "fixture",
              requirements: {
                loginMode: "runtime",
                image: "fixture",
                command: [],
                workspaceMounts: [],
                files: [],
                environment: [],
                labels: {},
                credentialAttachments: [],
                proxyWiring: wiring,
              },
            }),
            (startup, current) => signComputeExecutionRelease(privateKey, startup, current),
          ),
          true,
        );
        return f.compute.prepareRevision(revision);
      },
      verifyRepositoryExecution: (revision: AgentRevision, signal: AbortSignal) =>
        release.sandbox.repositoryAccess!.verifyExecution({
          revision,
          signal,
          namespace,
          kubernetes: undefined,
        }),
    };
    const { actor, observerPool: pool } = f;
    const backends = apiDrivers.installation.backend;
    const controller = createBackendController(f, { backends });
    const { id: who } = actor;
    controller.installDriver(apiOwner, ["sandbox", "credential_proxy"]);
    for (const d of [apiDrivers.repositoryPolicy!, compute]) {
      controller.registerDriver(d);
      controller.selectDriver(d.capability, d.id);
    }
    const repositoryRef = broad?.installation.repositoryRef ?? "source";
    const approvalId = randomUUID();
    const { id: configurationId } = await controller.createConfiguration(who, {
      namespaceId,
      kind: "agent",
      values: createHarnessConfiguration("codex", "fixture"),
    });
    const { id: agentId } = await controller.createAgent(
      who,
      {
        namespaceId,
        configurationId,
        name: "External Git",
        executionMode: "dedicated",
        harnessAuth: { method: "runtime" },
        repositoryBindings: [
          {
            repositoryRef,
            profile: broad ? "github-installation" : "git-write",
          },
        ],
      },
      resolveApprovedHarness,
    );
    const key = { namespaceId, agentId, configurationId };
    const [review] = await controller.listAgentStandingApprovalScopes(
      who,
      namespaceId,
      key.agentId,
    );
    await controller.updateAgent(
      who,
      {
        ...key,
        repositoryStandingApproval: {
          repositoryRef,
          approvalId,
          approved: true,
          duration: "until-removed",
          expectedScopeFingerprint: review!.scopeFingerprint,
        },
      },
      resolveApprovedHarness,
    );
    const deploy = () => controller.deployAgent(who, key, resolveApprovedHarness);
    if (broad) {
      capability.profile = "repository_git";
      await assert.rejects(deploy, /did not confirm installation-wide repository access/);
      assert.equal(gh.issuesOfTokens.length, 0);
      capability.profile = "github_installation";
    }
    const probes = capability.requests;
    const revision = await deploy();
    assert.ok(capability.requests > probes, "API admission reached the capability-only HTTPS peer");
    assert.deepEqual(revision.executionAdmission, {
      version: online ? 5 : 4,
      mode: "protected",
    });
    assert.deepEqual(revision.egressPlan?.driver, owner.ref);
    assert.equal(revision.repositoryCredentials?.standingApprovalId, approvalId);
    assert.equal(revision.harnessAuth.method, "runtime");
    const ref = { ...key, revisionId: revision.id };
    try {
      await f.start(compute, {
        transformDrivers: () => ({
          ...drivers,
          computeDriver: compute,
          configurationDriver: controller.selectedDriver("configuration"),
        }),
      });
      await waitFor(
        "worker's standing execution",
        () => f.state.read((v) => v.repositorySessions.findStandingExecution(ref)),
        25_000,
      );
      assert.equal(
        gh.issuesOfTokens.length,
        0,
        "observation and enrollment did not mint a credential",
      );
      await prepared.maintain();
      const first = await peer.install();

      const cwd = await temporaryDirectory(t, "cedar-git-destination-");
      const env = cleanEnvironment({ GIT_SSL_CAINFO: certFile });
      const git = (args: string[], allowFailure = false) =>
        run("git", ["-C", cwd, ...args], {
          env,
          allowFailure,
          timeout: 15_000,
        });
      await git(["init", "--quiet"]);
      const { traffic } = origin;
      const remote = new URL("/" + origin.repository + ".git", peer.url).href;
      // Actual Git credential protocol: the Driver's 401 makes Git invoke the host-scoped
      // helper. It returns only a marker; the provider separately proves that marker is useless.
      const auth = broad
        ? "credential." +
          peer.url.origin +
          '.helper=!f() { test "$1" != get || printf \'username=x-access-token\\npassword=' +
          peer.gitMarker +
          "\\n'; }; f"
        : "http.extraHeader=" + peer.clientHeader;
      const fetch = (mayDeny = false) =>
        git(["-c", auth, "fetch", "--no-tags", remote, "refs/heads/main"], mayDeny);
      const transfer = async (oid: string) => {
        assert.notEqual(
          (await git(["cat-file", "-e", oid], true)).code,
          0,
          "destination must lack this exact commit",
        );
        const n = traffic().requests;
        await fetch();
        assert.equal(
          traffic().requests,
          n + (broad ? 3 : 2),
          "the real Git discovery and upload reached the private origin",
        );
        assert.equal((await git(["rev-parse", "FETCH_HEAD"])).stdout.trim(), oid);
        assert.equal((await git(["cat-file", "-t", oid])).stdout.trim(), "commit");
      };
      await transfer(await origin.ref("main"));
      if (broad) {
        const provider = broad.installation;
        const { repositories, apiRequests } = provider;
        const [a, b, c] = repositories;
        assert.deepEqual(
          repositories.map((repo) => repo.id),
          [71, 72, 73],
        );
        assert.equal(
          provider.acceptedGitRequests(),
          3,
          "Git v2 discovery, ls-refs and actual pack, with the installation token",
        );
        assert.equal(origin.trace.at(-1)!.gitProtocol, "version=2");
        await peer.replayLastInstallationExchange!();
        assert.equal(
          provider.acceptedGitRequests(),
          3,
          "replaying the exchange did not send a second pack",
        );

        await git(["checkout", "--quiet", "-b", "installation-feature", "FETCH_HEAD"]);
        await git([
          "-c",
          "user.name=Cedar",
          "-c",
          "user.email=cedar@example.test",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "Work in the second private repository",
        ]);
        const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
        const providerGit = (args: string[], allowFailure = false) =>
          run("git", ["-C", origin.bare, ...args], { env, allowFailure });
        assert.notEqual(
          (await providerGit(["cat-file", "-e", commit], true)).code,
          0,
          "the push must transfer a new object",
        );
        await git(["-c", auth, "push", "--quiet", remote, "HEAD:refs/heads/installation-feature"]);
        assert.equal(await origin.ref("refs/heads/installation-feature"), commit);
        await providerGit(["fsck", "--strict"]);
        await providerGit(["config", "receive.hideRefs", "refs/heads/provider-protected"]);
        const blocked = await git(
          ["-c", auth, "push", remote, "HEAD:refs/heads/provider-protected"],
          true,
        );
        assert.notEqual(blocked.code, 0);
        assert.match(
          blocked.stderr,
          /deny updating a hidden ref/,
          "the provider still enforces its branch policy",
        );

        const api = (
          path: string,
          method = "GET",
          body?: object,
          target = peer.apiUrl,
          host = target.host,
        ) =>
          new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
            request(
              target,
              {
                ca: tls.ca,
                agent: false,
                family: 4,
                signal: t.signal,
                path,
                method,
                headers: {
                  host,
                  authorization:
                    target === peer.url
                      ? "Basic " +
                        Buffer.from("x-access-token:" + peer.gitMarker).toString("base64")
                      : "Bearer " + peer.gitMarker,
                  ...(body && { "content-type": "application/json" }),
                },
              },
              (res) => {
                const status = res.statusCode!;
                if (!res.headers["content-type"]?.startsWith("application/json")) {
                  res.resume();
                  resolve({ status, data: {} });
                  return;
                }
                void json(res).then(
                  (data) =>
                    resolve({
                      status,
                      data: data as Record<string, unknown>,
                    }),
                  reject,
                );
              },
            )
              .once("error", reject)
              .end(body && JSON.stringify(body));
          });
        const repos = "/repos/";
        const atB = repos + origin.repository;
        const initial = apiRequests.length;
        for (const [path, target, host] of [
          [atB, peer.url, peer.url.host], // API cannot travel on the Git route
          ["/installation/token", peer.apiUrl, peer.apiUrl.host],
          [atB, peer.apiUrl, "credentials.example.test"],
        ] as const) {
          assert.equal(
            (await api(path, "GET", undefined, target, host)).status,
            403,
            "route denial for " + host + path,
          );
        }
        assert.equal(
          apiRequests.length,
          initial,
          "wrong host, route and credential-owner paths never reached the provider",
        );
        for (const repo of [a!, b!]) {
          const { status, data } = await api(repos + repo.full_name);
          assert.equal(status, 200);
          assert.equal(data.full_name, repo.full_name);
          assert.equal(data.id, repo.id);
          assert.equal(data.private, true);
        }
        for (const resource of ["issues", "pulls"]) {
          const at = atB + "/" + resource;
          const { data, status } = await api(at, "POST", {
            title: "Installation work",
            head: "installation-feature",
            base: "main",
            draft: false,
          });
          assert.equal(status, 201);
          const edit = await api(at + "/" + data.number, "PATCH", {
            title: "Updated work",
          });
          assert.equal(edit.status, 200);
          assert.equal(edit.data.title, "Updated work");
        }
        const query =
          '{ repository(owner: "fixture", name: "private-b") { nameWithOwner isPrivate } }';
        const graph = await api("/graphql", "POST", { query });
        assert.equal(graph.status, 200);
        const result = (
          graph.data as {
            data: {
              repository: { nameWithOwner: string; isPrivate: boolean };
            };
          }
        ).data.repository;
        assert.equal(result.nameWithOwner, origin.repository);
        assert.equal(result.isPrivate, true);
        assert.equal(
          c!.private,
          true,
          "the provider independently knows that C exists and is private",
        );
        const missing = "fixture/never-existed";
        for (const name of [c!.full_name, missing]) {
          const path = repos + name;
          const masked = { status: 404, data: { message: "Not Found" } };
          assert.deepEqual(await api(path), masked, "the workload sees the same masked 404");
          assert.deepEqual(apiRequests.at(-1), {
            path,
            authenticated: true,
            exists: name !== missing,
            selected: false,
            status: 404,
          });
        }
      }

      // Send raw request targets through the working sender. Even targets resolving to the
      // allowed URL must be refused before authorization or any connection to the private origin.
      const discovery = `/${origin.repository}.git/info/refs?service=git-upload-pack`;
      const upstream = new URL(origin.origin);
      const ca = await readFile(certFile);
      const headers = {
        host: peer.url.host,
        authorization: broad
          ? "Basic " + Buffer.from("x-access-token:" + peer.gitMarker).toString("base64")
          : peer.clientHeader.slice("Authorization: ".length),
      };
      const prior = { traffic: traffic(), decisions: peer.decisions.length };
      // Cross the listeners with a valid workload marker and the protected Host header.
      // Neither public discovery on the sender nor a Git operation on discovery may reach authority.
      for (const [target, path, expectedStatus] of [
        [capabilityOrigin, discovery, 404],
        [peer.url, "/capability", 403],
        [peer.url, `//${upstream.host}${discovery}`, 403],
        [peer.url, peer.url.origin + discovery, 403],
        [peer.url, "/elsewhere/.." + discovery, 403],
      ] as const) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          get(target, { path, ca, headers, signal: t.signal }, (res) => {
            res.resume();
            resolve(res.statusCode);
          }).once("error", reject);
        });
        assert.equal(status, expectedStatus, path);
        assert.deepEqual({ traffic: traffic(), decisions: peer.decisions.length }, prior, path);
      }

      // The same working sender now holds a committed positive until its actual send cutoff,
      // while the original request is still in time. Never ask for a second authorization.
      for (const holdAt of online
        ? []
        : broad
          ? (["request"] as const)
          : (["connect", "request"] as const)) {
        const before = traffic();
        const decisions = peer.decisions.length;
        const held: {
          permit: RepositoryGitSendPermit;
          releaseAt: number;
          deadlineAt: string;
        }[] = [];
        peer.beforeSend = async (stage, permit, deadlineAt) => {
          if (stage !== holdAt) {
            return;
          }
          const until = Date.parse(permit.sendStartBy);
          let releaseAt = Date.now();
          assert.ok(releaseAt < until, "the sender received a live, committed permit");
          while (releaseAt < until) {
            await delay(until - releaseAt, undefined, { signal: t.signal });
            releaseAt = Date.now();
          }
          held.push({ permit, releaseAt, deadlineAt });
        };
        const expired = await fetch(true);
        delete peer.beforeSend;
        assert.deepEqual(
          traffic(),
          {
            connections: before.connections + Number(holdAt === "request"),
            requests: before.requests,
          },
          `expired permit before ${holdAt} must not start an origin request`,
        );
        assert.equal(
          held.length,
          1,
          "the already issued permit crossed its send cutoff exactly once",
        );
        const { permit, releaseAt, deadlineAt } = held[0]!;
        assert.ok(
          Date.parse(permit.sendStartBy) <= releaseAt && releaseAt < Date.parse(deadlineAt),
        );
        assert.deepEqual(peer.decisions.slice(decisions), [
          { operation: "advertise-upload-pack", decision: permit },
        ]);
        const { rows } = await pool.query(
          `SELECT send_start_by, material_version, attempt_id, request_digest_sha256
           FROM occ.prepared_repository_git_uses WHERE exchange_id=$1`,
          [permit.exchangeId],
        );
        assert.deepEqual(
          rows,
          [
            {
              send_start_by: new Date(permit.sendStartBy),
              material_version: permit.materialVersion,
              attempt_id: permit.preparationAttemptId,
              request_digest_sha256: permit.requestDigestSha256,
            },
          ],
          "possible use remains committed with exactly the permit the sender let expire",
        );
        assert.equal(expired.code, 128);
        assert.match(expired.stderr.toString(), /403/);
        t.diagnostic(
          `expired before ${holdAt}: ${JSON.stringify(before)} -> ${JSON.stringify(traffic())}, one possible use`,
        );
      }

      // Real owner deadlines: the 5-minute fixture token is inside the 10-minute renewal window.
      // Wait for the persisted next check, without extending or editing a token or session deadline.
      let second = first;
      if (!broad) {
        const {
          rows: [{ delay_ms }],
        } = await pool.query(
          "SELECT extract(epoch FROM next_check_at-clock_timestamp())*1000 AS delay_ms FROM occ.prepared_github_families WHERE enabled AND source #>> '{session,revisionId}'=$1",
          [revision.id],
        );
        await delay(Math.max(0, Number(delay_ms) + 25), undefined, {
          signal: t.signal,
        });
        await prepared.maintain();
        second = await peer.install();
        assert.notEqual(first.materialVersion, second.materialVersion);
        await transfer(await origin.addCommit());
      }
      const receiptCount = () =>
        pool
          .query(
            "SELECT count(*)::integer n FROM occ.prepared_repository_git_uses WHERE material_version=$1",
            [second.materialVersion],
          )
          .then((r) => r.rows[0].n);
      const committed = await receiptCount();
      if (broad) {
        assert.equal(
          committed,
          broad.installation.acceptedGitRequests() +
            broad.installation.apiRequests.length +
            Number(!online),
          "possible use per Git or API request and, for exact dispatch, the deliberately expired permit",
        );
      } else {
        assert.equal(committed, 2);
      }

      // Send another actual request to the same still-equipped sender. Check the transport and
      // HTTP boundaries before the client result, so an erroneous forward fails at the origin oracle.
      const providerTraffic = () => ({
        ...traffic(),
        apiRequests: broad?.installation.apiRequests.length,
        issues: gh.issuesOfTokens.length,
      });
      const before = providerTraffic();
      const decisions = peer.decisions.length;
      await controller.removeAgentStandingApproval(who, {
        ...key,
        approvalId,
        expectedGeneration: 1,
      });
      const denied = await fetch(true);
      assert.deepEqual(
        providerTraffic(),
        before,
        "no Git connection, API request or issuance may reach the provider after withdrawal",
      );
      assert.deepEqual(peer.decisions.slice(decisions), [
        {
          operation: "advertise-upload-pack",
          decision: { kind: "denied", reason: "access_withdrawn" },
        },
      ]);
      assert.equal(denied.code, 128);
      assert.match(denied.stderr.toString(), /403/);
      assert.ok(
        Date.now() < Date.parse(second.expiresAt),
        "withdrawal was tested while the installed credential was usable",
      );
      assert.equal(await receiptCount(), committed, "withdrawal did not add a possible use");
      if (broad) {
        await broad.installation.verifyTokenStillWorks();
        t.diagnostic(
          "one installation token, private Git v2 pack and push, provider-protected ref, REST and GraphQL; fresh Git denied after withdrawal, zero provider connection or HTTP, then direct proof the same token was still accepted",
        );
        return;
      }
      assert.ok("tokenState" in gh);
      const [, live] = gh.tokenState();
      assert.equal(live?.uses, 2);
      assert.equal(live.revoked, false);
      assert.equal(await receiptCount(), 2);
      t.diagnostic(
        "fetched two previously absent commits using distinct material; withdrawn request reached the same sender, with zero additional origin connections or HTTP requests",
      );
    } finally {
      await f.stop();
    }
  };
}

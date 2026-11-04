/** Three private repositories; the provider grants this installation access to A and B. */
import assert from "node:assert/strict";
import { randomBytes, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, request } from "node:https";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import {
  createTlsMaterial,
  listen,
  temporaryDirectory,
} from "../../repository-credentials/process.mjs";
import { startGitSmartHttpFixture } from "../../repository-credentials/git.mjs";
import { createRepositoryResources } from "../../repository-credentials/github/repository-resources.mjs";
import { sharedRsaKeyPair } from "../../repository-credentials/shared-keys.mjs";

export async function installationOrigin(t: TestContext, namespaceId: string) {
  const tls = await createTlsMaterial(t);
  const { privateKey, publicKey } = sharedRsaKeyPair("installation-journey-app");
  const backendId = "prepared-installation";
  const repositoryRef = "team-app-installation";
  const appId = "12345";
  const githubInstallationId = "41";
  const registry = {
    version: 1,
    backendId,
    providerInstanceId: "fixture-provider",
    appId,
    githubInstallationId,
    maximumDurationSeconds: 180,
    allowStandingApprovals: true,
    repositories: [],
    installationAccess: {
      repositoryRef,
      namespaces: [
        {
          namespaceId,
          accessMode: "installation",
          allowStandingApproval: true,
        },
      ],
    },
  };
  const directory = await temporaryDirectory(t, "cedar-installation-");
  const privateKeyPath = join(directory, "app.pem");
  const custodyKeyPath = join(directory, "custody");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(custodyKeyPath, randomBytes(32), { mode: 0o600 });

  const repository = "fixture/private-b";
  const firstRepository = "fixture/private-a";
  const outside = "fixture/private-outside-installation";
  const permissions = {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  };
  const repositories = [firstRepository, repository, outside].map((repository, i) =>
    createRepositoryResources({ repository, repositoryId: String(71 + i) }),
  );
  const installationRepositoryIds = new Set([71, 72]);
  const apiRequests: {
    path: string;
    authenticated: boolean;
    exists: boolean;
    selected: boolean;
    status: number;
  }[] = [];
  let gitUses = 0;
  let issueCount = 0;
  let token: string | undefined;
  let expires = 0;
  const basic = (value: string) =>
    "Basic " + Buffer.from("x-access-token:" + value).toString("base64");

  const server = createServer(tls, (req, res) => {
    void (async () => {
      const path = req.url!;
      const auth = req.headers.authorization;
      const body = await text(req);
      if (
        req.method === "POST" &&
        path === "/app/installations/" + githubInstallationId + "/access_tokens"
      ) {
        // Check what the production issuer actually sent, including its App signature. A narrowed
        // request cannot accidentally pass this journey. Assertion diagnostics never include a credential.
        assert.ok(body === "{}", "issuance must not narrow repositories or permissions");
        assert.ok(auth && auth.startsWith("Bearer "), "expected an App bearer");
        const [header, claims, signature] = auth.slice(7).split(".");
        assert.ok(header && claims && signature, "expected an App JWT");
        assert.ok(
          verify(
            "sha256",
            Buffer.from(header + "." + claims),
            publicKey,
            Buffer.from(signature, "base64url"),
          ),
        );
        const jwt = JSON.parse(Buffer.from(claims, "base64url").toString());
        assert.ok(
          String(jwt.iss) === appId && jwt.iat <= Date.now() / 1000 && Date.now() / 1000 < jwt.exp,
        );
        assert.equal(++issueCount, 1, "the fixture permits exactly one token issue");
        token = "fixture_installation_" + randomBytes(24).toString("hex");
        expires = Date.now() + 3600_000;
        res.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({
            token,
            expires_at: new Date(expires).toISOString(),
            repository_selection: "selected",
            permissions,
          }),
        );
        return;
      }
      const authenticated = !!token && auth === "Bearer " + token && Date.now() < expires;
      const url = new URL(path, "https://api.github.com");
      // The journey's GraphQL query is for B. REST must resolve the exact repository first.
      const name = path === "/graphql" ? repository : url.pathname.split("/").slice(2, 4).join("/");
      const resource = repositories.find(({ repo }) => repo.full_name === name);
      const selected = !!resource && installationRepositoryIds.has(resource.repo.id);
      const result = !authenticated
        ? { status: 401, body: { message: "Requires an installation token" } }
        : selected
          ? resource.dispatch({
              method: req.method,
              url,
              body: JSON.parse(body || "{}"),
              accept: "",
              permissions,
            })
          : { status: 404, body: { message: "Not Found" } };
      apiRequests.push({
        path,
        authenticated,
        exists: !!resource,
        selected,
        status: result.status,
      });
      res
        .writeHead(result.status, { "content-type": "application/json" })
        .end(JSON.stringify("body" in result ? result.body : {}));
    })().catch(() => res.writeHead(500).end());
  });
  const apiOrigin = await listen(t, server);
  const createGit: (
    t: TestContext,
    options: object,
  ) => ReturnType<typeof startGitSmartHttpFixture> = startGitSmartHttpFixture;
  const origin = await createGit(t, {
    repository,
    tls,
    authorize: (auth: string | undefined) => {
      const valid = !!token && auth === basic(token) && Date.now() < expires;
      if (valid) {
        gitUses++;
      }
      return valid;
    },
  });
  const repositoryPath = "/" + repository + ".git/info/refs?service=git-upload-pack";
  const directGitStatus = (authorization?: string) =>
    new Promise<number>((resolve, reject) => {
      request(
        origin.origin,
        {
          path: repositoryPath,
          ca: tls.ca,
          agent: false,
          headers: authorization ? { authorization } : {},
          signal: t.signal,
        },
        (res) => {
          res.resume().once("end", () => resolve(res.statusCode!));
        },
      )
        .once("error", reject)
        .end();
    });
  for (const credential of [undefined, basic("cedar-workload-marker"), "Bearer wrong-token"]) {
    assert.equal(
      await directGitStatus(credential),
      401,
      "private Git at B refuses anonymous and ineffective credentials",
    );
  }
  return {
    registry,
    backendId,
    origin,
    tls,
    privateKeyPath,
    custodyKeyPath,
    gh: {
      origin: apiOrigin,
      get issuesOfTokens() {
        return Array.from({ length: issueCount });
      },
    },
    installation: {
      repository,
      // Provider-side inventory is never part of an installation-authenticated response.
      repositories: repositories.map(({ repo }) => repo),
      apiRequests,
      repositoryRef,
      acceptedGitRequests: () => gitUses,
      async verifyTokenStillWorks() {
        assert.ok(token && expires > Date.now());
        assert.equal(
          await directGitStatus("Bearer " + token),
          401,
          "the token as Bearer cannot pass Git authentication",
        );
        assert.equal(
          await directGitStatus(basic(token)),
          200,
          "after the withdrawal observation, the provider still accepts the exact token",
        );
      },
    },
  };
}

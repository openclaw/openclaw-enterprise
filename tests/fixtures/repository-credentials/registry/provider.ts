import { createServer, request as httpsRequest } from "node:https";
import type { ClientRequest } from "node:http";
import type { RepositoryCredentialSessionResult } from "../../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { createControlledClock } from "../clock.mjs";
import { startGitHubFixture } from "../github.mjs";
import { startGitSmartHttpFixture } from "../git.mjs";
import { listen, type createTlsMaterial } from "../process.mjs";
import type { FixtureOwner, RegistryFixtureDefinition } from "./material.ts";

type TlsMaterial = Awaited<ReturnType<typeof createTlsMaterial>>;
type ProviderTransportOptions = {
  tls: TlsMaterial;
  select(
    pathname: string,
  ): { origin: string } | undefined | Promise<{ origin: string } | undefined>;
};
type GitHubRequestTrace = {
  method: string | undefined;
  target: string | undefined;
  userAgent: string | undefined;
  apiVersion: string | string[] | undefined;
  graphQLFeatures: string | string[] | undefined;
  accept: string | undefined;
  tokenIndex: number | undefined;
  query?: string;
  variables?: Record<string, unknown>;
  operation?: "createPullRequest" | "query";
  forwardedOperationId?: boolean;
  usedBearer?: boolean;
};

type GitHubTokenState = {
  index: number;
  expires: number;
  revoked: boolean;
  uses: number;
  attempts: number;
  permissions: Readonly<Record<string, string>>;
  repositoryIds?: readonly string[] | "installation";
  static?: true;
};

export type GitHubFixture = Omit<
  Awaited<ReturnType<typeof startGitHubFixture>>,
  "trace" | "errors" | "issuesOfTokens" | "authenticationAttempts" | "tokenState"
> & {
  trace: readonly GitHubRequestTrace[];
  errors: readonly string[];
  issuesOfTokens: readonly {
    index: number;
    jwtDigest: string;
    claims: Readonly<Record<string, unknown>>;
    permissions: Readonly<Record<string, string>>;
    repositoryIds: readonly (string | number)[] | "installation";
    expires: number;
  }[];
  authenticationAttempts: readonly { tokenIndex: number | undefined; boundary: string }[];
  tokenState(): GitHubTokenState[];
};

type GitRequestTrace = {
  method: string | undefined;
  path: string;
  gitProtocol: string | string[] | undefined;
  contentEncoding: string | undefined;
  contentLength: string | undefined;
};
type GitFixture = Omit<Awaited<ReturnType<typeof startGitSmartHttpFixture>>, "trace"> & {
  trace: readonly GitRequestTrace[];
};
type RegistryProviderRepository = RegistryFixtureDefinition & {
  github: GitHubFixture;
  git: GitFixture;
  opened?: RepositoryCredentialSessionResult;
  clientDirectory?: string;
};
type RegistryProviderOptions = {
  definitions: readonly RegistryFixtureDefinition[];
  clock: ReturnType<typeof createControlledClock>;
  tls: TlsMaterial;
};

async function startProviderTransport(
  resources: FixtureOwner,
  { tls, select }: ProviderTransportOptions,
) {
  const outgoing = new Set<ClientRequest>();
  const server = createServer(tls, (request, response) => {
    void (async () => {
      const target = request.url ?? "";
      const [pathname = ""] = target.split("?", 1);
      // Match only a path that the provider will interpret the same way.
      if (
        !/^\/[\x21-\x7e]*$/.test(target) ||
        target.startsWith("//") ||
        /[\\#]/.test(target) ||
        URL.parse(pathname, "https://fixture.invalid")?.pathname !== pathname
      ) {
        response.writeHead(400).end();
        return;
      }
      const selected = await select(pathname);
      if (!selected) {
        response.writeHead(404).end();
        return;
      }
      // This is only a controlled provider's fixed dispatch table. Session
      // admission and repository authority remain in the real gateway factory.
      const origin = new URL(selected.origin);
      const upstream = httpsRequest(
        origin,
        {
          path: target,
          method: request.method,
          headers: { ...request.headers, host: origin.host },
          ca: tls.ca,
          agent: false,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode!, incoming.headers);
          incoming.on("error", () => response.destroy());
          incoming.pipe(response);
        },
      );
      outgoing.add(upstream);
      upstream.once("close", () => outgoing.delete(upstream));
      upstream.once("error", () => response.destroy());
      upstream.setTimeout(30000, () => upstream.destroy(new Error("provider fixture timeout")));
      response.once("close", () => upstream.destroy());
      request.once("error", () => upstream.destroy());
      request.pipe(upstream);
    })().catch(() => response.destroy());
  });
  const origin = await listen(resources, server);
  resources.after(() => {
    for (const upstream of outgoing) {
      upstream.destroy();
    }
  });
  return origin;
}

export async function startRegistryProviderFixtures(
  resources: FixtureOwner,
  { definitions, clock, tls }: RegistryProviderOptions,
) {
  const repositories: RegistryProviderRepository[] = [];
  for (const definition of definitions) {
    const entry = { ...definition };
    const githubOptions = {
      clock,
      tls,
      repository: entry.repository,
      repositoryId: entry.repositoryId,
      description: entry.description,
      beforeMetadataResponse: entry.beforeMetadataResponse,
    };
    const github: GitHubFixture = await startGitHubFixture(resources, githubOptions);
    const git = await startGitSmartHttpFixture(resources, {
      tls,
      repository: entry.repository,
      authorize: github.authorize,
    });
    repositories.push({ ...entry, github, git });
  }
  const apiOrigin = await startProviderTransport(resources, {
    tls,
    async select(pathname) {
      const repository = repositories.find((entry) => {
        const prefix = `/repos/${entry.repository}`;
        return pathname === prefix || pathname.startsWith(`${prefix}/`);
      });
      if (repository) {
        return { origin: repository.github.origin };
      }
      return undefined;
    },
  });
  const gitOrigin = await startProviderTransport(resources, {
    tls,
    select(pathname) {
      const entry = repositories.find((item) => {
        const prefix = `/${item.repository}.git`;
        return pathname === prefix || pathname.startsWith(`${prefix}/`);
      });
      return entry && { origin: entry.git.origin };
    },
  });
  return { repositories, apiOrigin, gitOrigin };
}

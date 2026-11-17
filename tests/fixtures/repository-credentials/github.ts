import { createServer, type Server } from "node:https";
import { createControlledClock } from "./clock.ts";
import { createTlsMaterial, listen } from "./process.ts";
import { createGitHubProtocol, type GitHubProtocolOptions } from "./github/protocol.ts";
import type { FixtureOwner } from "./resources.ts";

export {
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  fixtureAppId,
  humanText,
} from "./github/metadata.ts";

type DefaultTlsMaterial = Awaited<ReturnType<typeof createTlsMaterial>>;
type TlsMaterial = Pick<DefaultTlsMaterial, "key" | "cert" | "ca"> &
  Partial<Pick<DefaultTlsMaterial, "keyFile" | "certFile">>;

export type GitHubFixtureOptions = Partial<GitHubProtocolOptions> & { tls?: TlsMaterial };

// The process shares one certificate, so issuer authorities differ only by port.
// Never reuse an origin: the new fixture would adopt prepared rows it cannot decrypt.
const origins = new Set<string>();

/** Listen on an origin no earlier issuer in this process used. A reused port stays bound. */
export async function listenOnNewOrigin(t: FixtureOwner, createIssuer: () => Server) {
  let origin: string;
  do {
    origin = await listen(t, createIssuer());
  } while (origins.has(origin));
  origins.add(origin);
  return origin;
}

export function startGitHubFixture(
  t: FixtureOwner,
  options?: Omit<GitHubFixtureOptions, "tls"> & { tls?: DefaultTlsMaterial },
): Promise<GitHubFixture<DefaultTlsMaterial>>;
export function startGitHubFixture(
  t: FixtureOwner,
  options: GitHubFixtureOptions,
): Promise<GitHubFixture>;
export async function startGitHubFixture(
  t: FixtureOwner,
  { clock = createControlledClock(), tls, ...options }: GitHubFixtureOptions = {},
) {
  const material = tls ?? (await createTlsMaterial(t));
  const { handleRequest, ...fixture } = createGitHubProtocol({ clock, ...options });
  let refusals = 0;
  const origin = await listenOnNewOrigin(t, () => {
    const server = createServer(material, handleRequest);
    // A dropped TCP connection before TLS: the client cannot have sent a request.
    server.prependListener("connection", (socket) => {
      if (refusals > 0) {
        refusals--;
        socket.destroy();
      }
    });
    return server;
  });
  return {
    origin,
    tls: material,
    ...fixture,
    /** Drop the next incoming connection before its TLS handshake. */
    refuseNextConnection() {
      refusals++;
    },
  };
}

export type GitHubFixture<Material extends TlsMaterial = TlsMaterial> = Omit<
  ReturnType<typeof createGitHubProtocol>,
  "handleRequest"
> & {
  origin: string;
  tls: Material;
  refuseNextConnection(): void;
};

import { createServer } from "node:https";
import { createControlledClock } from "./clock.mjs";
import { createTlsMaterial, listen } from "./process.mjs";
import { createGitHubProtocol } from "./github/protocol.mjs";

export {
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  fixtureAppId,
  humanText,
} from "./github/protocol.mjs";

// createTlsMaterial shares one certificate per process, so issuer authorities differ only by port.
// Never reuse an origin, or a fixture adopts an earlier one's prepared rows and cannot decrypt them.
const origins = new Set();

/** Listen on an origin no earlier issuer in this process used; a reused port stays bound. */
export async function listenOnNewOrigin(t, createIssuer) {
  let origin;
  do {
    origin = await listen(t, createIssuer());
  } while (origins.has(origin));
  origins.add(origin);
  return origin;
}

export async function startGitHubFixture(
  t,
  { clock = createControlledClock(), tls, ...options } = {},
) {
  tls ??= await createTlsMaterial(t);
  const { handleRequest, ...fixture } = createGitHubProtocol({ clock, ...options });
  const origin = await listenOnNewOrigin(t, () => createServer(tls, handleRequest));
  return { origin, tls, ...fixture };
}

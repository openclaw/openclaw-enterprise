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

// createTlsMaterial shares one certificate per process, so two fixtures' issuer authorities
// (origin plus CA) differ only by port. A fixture on an earlier fixture's reused ephemeral port
// would adopt that fixture's leftover prepared custody rows in the shared database and fail to
// decrypt them with its own key. Keep a reused port bound and listen again: no origin repeats.
const origins = new Set();

export async function startGitHubFixture(
  t,
  { clock = createControlledClock(), tls, ...options } = {},
) {
  tls ??= await createTlsMaterial(t);
  const { handleRequest, ...fixture } = createGitHubProtocol({ clock, ...options });
  let origin;
  do {
    origin = await listen(t, createServer(tls, handleRequest));
  } while (origins.has(origin));
  origins.add(origin);
  return { origin, tls, ...fixture };
}

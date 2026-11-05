import { setTimeout as delay } from "node:timers/promises";
import {
  PostgresHumanAuthentication,
  type GithubRosterMapping,
  type PostgresPlatformState,
} from "@openclaw-enterprise/occ";
import { betterAuthIssuer } from "../auth/configuration.ts";
import { createGitHubTeamRoster } from "../auth/github-team-roster.ts";

/** Poll due work independently of the Agent queue. State owns the six-hour schedule and
 * decides which worker may complete an attempt for this mapping generation. */
export function startGithubRosterWorker(
  state: PostgresPlatformState,
  installationId: string,
  mappings: readonly GithubRosterMapping[],
  tokenFile: string,
  reportUnavailable: (mappingId: string) => void,
) {
  const stop = new AbortController();
  const reader = createGitHubTeamRoster(tokenFile);
  const persistence = new PostgresHumanAuthentication(
    state,
    installationId,
    betterAuthIssuer(installationId),
  );
  async function run() {
    while (!stop.signal.aborted) {
      for (const mapping of mappings) {
        if (stop.signal.aborted) {
          return;
        }
        try {
          const claim = await persistence.claimRosterRefresh(mapping);
          if (!claim) {
            continue;
          }
          const result = await reader.readServiceRoster(
            mapping,
            claim.subjects,
            AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]),
          );
          await persistence.finishRosterRefresh(claim, result);
          if (result.status === "unavailable") {
            reportUnavailable(mapping.id);
          }
        } catch {
          // An unfinished lease expires in State. Never resubmit a possibly committed finish.
          reportUnavailable(mapping.id);
        }
      }
      await delay(60_000, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  const loop = run();
  return {
    async close() {
      stop.abort();
      await loop;
    },
  };
}

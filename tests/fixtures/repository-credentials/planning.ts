import type { TestContext } from "node:test";
import type {
  Clock,
  Denied,
  RequestHead,
  RequestPlan,
} from "../../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type {
  GitHubProfile,
  GitHubTokenConfiguration,
} from "../../../apps/controller/src/drivers/repo/github/access/types.ts";
import { appFunction } from "./app-functions.ts";
import { createControlledClock } from "./clock.ts";
import { createResourceScope } from "./resources.ts";
import {
  githubTokenConfigurationData,
  serviceConfigurationData,
  custodyLimits,
} from "./builders.ts";

interface ResourceScope {
  after(cleanup: () => void): void;
  close(primaryError?: unknown): Promise<void>;
}

const createPlanningResources: () => ResourceScope = createResourceScope;
const createPlanningClock: (wallMs: number) => Clock = createControlledClock;
const serviceData: () => unknown = serviceConfigurationData;
const tokenData: (overrides: Partial<GitHubTokenConfiguration>) => unknown =
  githubTokenConfigurationData;

export async function createGitHubPlanningFixture(
  t: Pick<TestContext, "after">,
  overrides: Partial<GitHubTokenConfiguration> = {},
) {
  const resources = createPlanningResources();
  try {
    const [
      createGitHubDriverFactory,
      createGitHubStaticTokenOwner,
      validateServiceConfig,
      admitSession,
      createCustody,
      validateGitHubConfiguration,
    ] = await Promise.all([
      appFunction("drivers/repo/github/access/factory", "createGitHubDriverFactory"),
      appFunction("drivers/repo/github/access/static-token", "createGitHubStaticTokenOwner"),
      appFunction("drivers/repo/access/configuration", "validateServiceConfig"),
      appFunction("drivers/repo/access/sessions", "admitSession"),
      appFunction("drivers/repo/access/custody", "createCustody"),
      appFunction("drivers/repo/github/access/config", "validateGitHubConfiguration"),
    ]);
    const clock = createPlanningClock(1700000000000);
    const config = validateServiceConfig(serviceData());
    const configuration = tokenData({ allowGraphql: true, ...overrides });
    const owner = createGitHubStaticTokenOwner({
      token: Buffer.from(`github_pat_${"t".repeat(36)}`),
    });
    resources.after(() => owner.close());
    const factory = createGitHubDriverFactory({
      configuration: validateGitHubConfiguration(configuration),
      authority: owner,
      clock,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
    });
    const bind = (profile: GitHubProfile = "git-full") => {
      const admitted = admitSession(
        factory.resolve(profile).binding,
        clock.wallNow() + 86400 * 1000,
        clock,
      );
      const custody = createCustody({
        clock,
        ...custodyLimits,
        admitted: () => true,
        changed() {},
      });
      const driver = factory.create({
        authority: admitted.authority,
        custody: custody.driver,
        clock,
      });
      return {
        authority: admitted.authority,
        driver,
        plan: (head: RequestHead): RequestPlan | Denied =>
          driver.plan({ authority: admitted.authority, session: admitted.ref, head }),
      };
    };
    t.after(() => resources.close());
    return { factory, owner, bind, clock };
  } catch (error) {
    await resources.close(error);
    throw error;
  }
}

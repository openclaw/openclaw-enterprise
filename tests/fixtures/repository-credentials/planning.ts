import type { TestContext } from "node:test";
import type {
  Denied,
  RequestHead,
  RequestPlan,
} from "../../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import type {
  GitHubProfile,
  GitHubTokenConfiguration,
} from "../../../apps/controller/src/drivers/repo/github/credentials/types.ts";
import { appModule } from "./runtime.mjs";
import { createControlledClock } from "./clock.mjs";
import { createResourceScope } from "./resources.mjs";
import {
  githubTokenConfigurationData,
  serviceConfigurationData,
  custodyLimits,
} from "./builders.mjs";

export async function createGitHubPlanningFixture(
  t: Pick<TestContext, "after">,
  overrides: Partial<GitHubTokenConfiguration> = {},
) {
  const resources = createResourceScope();
  try {
    const [
      { createGitHubDriverFactory },
      { createGitHubStaticTokenOwner },
      { validateServiceConfig },
      { admitSession },
      { createCustody },
      { validateGitHubConfiguration },
    ]: [
      typeof import("../../../apps/controller/src/drivers/repo/github/credentials/factory.ts"),
      typeof import("../../../apps/controller/src/drivers/repo/github/credentials/static-token.ts"),
      typeof import("../../../apps/controller/src/drivers/repo/credentials/configuration.ts"),
      typeof import("../../../apps/controller/src/drivers/repo/credentials/sessions.ts"),
      typeof import("../../../apps/controller/src/drivers/repo/credentials/custody.ts"),
      typeof import("../../../apps/controller/src/drivers/repo/github/credentials/config.ts"),
    ] = await Promise.all([
      appModule("drivers/repo/github/credentials/factory"),
      appModule("drivers/repo/github/credentials/static-token"),
      appModule("drivers/repo/credentials/configuration"),
      appModule("drivers/repo/credentials/sessions"),
      appModule("drivers/repo/credentials/custody"),
      appModule("drivers/repo/github/credentials/config"),
    ]);
    const clock = createControlledClock(1700000000000);
    const config = validateServiceConfig(serviceConfigurationData());
    const configuration = githubTokenConfigurationData({ allowGraphql: true, ...overrides });
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

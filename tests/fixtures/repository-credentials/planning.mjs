import { appModule } from "./runtime.mjs";
import { createControlledClock } from "./clock.mjs";
import { createResourceScope } from "./resources.mjs";
import {
  githubTokenConfigurationData,
  serviceConfigurationData,
  custodyLimits,
} from "./builders.mjs";

export async function createGitHubPlanningFixture(t, overrides = {}) {
  const resources = createResourceScope();
  try {
    const [
      { createGitHubDriverFactory, createGitHubStaticTokenOwner },
      { validateServiceConfig },
      { admitSession },
      { createCustody },
    ] = await Promise.all([
      appModule("drivers/repo/github/credentials/index"),
      appModule("drivers/repo/credentials/configuration"),
      appModule("drivers/repo/credentials/sessions"),
      appModule("drivers/repo/credentials/custody"),
    ]);
    const clock = createControlledClock(1700000000000);
    const config = validateServiceConfig(serviceConfigurationData());
    const configuration = githubTokenConfigurationData({ allowGraphql: true, ...overrides });
    const owner = createGitHubStaticTokenOwner({
      token: Buffer.from(`github_pat_${"t".repeat(36)}`),
    });
    resources.after(() => owner.close());
    const factory = createGitHubDriverFactory({
      configuration,
      authority: owner,
      clock,
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
    });
    const bind = (profile = "git-full") => {
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
        plan: (head) => driver.plan({ authority: admitted.authority, session: admitted.ref, head }),
      };
    };
    t.after(() => resources.close());
    return { factory, owner, bind, clock };
  } catch (error) {
    await resources.close(error);
  }
}

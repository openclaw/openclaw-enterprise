import { generateKeyPairSync } from "node:crypto";
import { appModule } from "./runtime.mjs";
import { createControlledClock } from "./clock.mjs";
import { createResourceScope } from "./resources.mjs";
import { githubConfigurationData, serviceConfigurationData } from "./builders.mjs";

export async function createGitHubPlanningFixture(t) {
  const resources = createResourceScope();
  try {
    const [
      { createGitHubDriverFactory, createGitHubKeyOwner },
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
    const configuration = githubConfigurationData();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = createGitHubKeyOwner({ privateKey, appId: configuration.appId, clock });
    resources.after(() => key.close());
    const factory = createGitHubDriverFactory({
      configuration,
      authority: key,
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
        maximumSlots: 2,
        maximumAccessBytes: 16384,
        maximumRenewalBytes: 16384,
        maximumCallbacks: 2,
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
    return { factory, key, publicKey, bind };
  } catch (error) {
    await resources.close(error);
  }
}

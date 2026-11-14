import { isFixtureNetworkPolicy } from "./repository-runtime-material-kubernetes-fixture.ts";
import assert from "node:assert/strict";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { protectedRepositoryGitRelease } from "../helpers/protected-repository-git-release.ts";
import {
  fixture,
  codexAppServer,
  computeFixturePorts,
  type MaterialFixture,
} from "./repository-runtime-material-fixture.ts";

export const publicReader = {
  namespace: "control",
  podLabels: { app: "read-public-github" },
  address: "10.43.0.19",
};

export function publicReaderPolicies(f: MaterialFixture) {
  return [...f.objects.values()]
    .filter(isFixtureNetworkPolicy)
    .filter(({ spec }) =>
      spec.egress?.some(({ to }) =>
        to?.some(({ podSelector }) => podSelector?.matchLabels?.app === publicReader.podLabels.app),
      ),
    );
}

// An independently admitted unprotected revision selects the exact anonymous reader.
export async function publicReaderAdmission() {
  const f = await fixture("dedicated", undefined, { publicGithubRead: publicReader });
  const { revision, driver } = f;
  delete revision.repositoryCredentials;
  codexAppServer(revision.configuration).networkProxy = {
    enabled: true,
    domains: { [publicReader.address]: "allow" },
  };
  const admission = driver.admitRevision(revision);
  assert.ok(admission);
  assert.match(admission, /^model-provider:v1:[a-f0-9]{64}:public-github-read:v1:[a-f0-9]{64}$/);
  return { f, revision, driver, admission };
}

export function computeAfterProxyCutover(f: MaterialFixture) {
  const { owner } = protectedRepositoryGitRelease(() =>
    assert.fail("Reader withdrawal must never use protected repository access"),
  );
  const driver = new KubernetesComputeDriver(f.ports.options, { protectedDriver: owner });
  computeFixturePorts(driver).apiClients = Promise.resolve(f.clients);
  return driver;
}

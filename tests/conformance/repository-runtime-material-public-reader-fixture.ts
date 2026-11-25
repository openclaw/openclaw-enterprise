import { isFixtureNetworkPolicy } from "./repository-runtime-material-kubernetes-fixture.ts";
import type { MaterialFixture } from "./repository-runtime-material-fixture.ts";

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

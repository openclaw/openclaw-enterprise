import { describe } from "node:test";
import {
  registerBuildKitCases,
  registerVerifiedRuntimePublicationCase,
} from "./ci-prepare-k3d-buildkit-cases.ts";
import {
  registerClusterBootstrapCases,
  registerClusterCreateCases,
  registerClusterImageImportCases,
  registerFixtureBuildDeadlineCases,
  registerFixtureStorageCases,
} from "./ci-prepare-k3d-cluster-cases.ts";
import {
  registerAgentSandboxImageCustodyCase,
  registerHostImageCustodyCases,
} from "./ci-prepare-k3d-image-custody-cases.ts";
import {
  registerBoundedNodeLogCases,
  registerNodeLogChronologyCases,
} from "./ci-prepare-k3d-node-log-cases.ts";
import { registerRuntimeProvenanceCases } from "./ci-prepare-k3d-provenance-cases.ts";
import { registerNativeTimingCases } from "./ci-prepare-k3d-timing-cases.ts";

registerNativeTimingCases();
registerRuntimeProvenanceCases();
// Each case waits on its own fake k3d and container engine processes, mostly for
// deliberate timeouts, so the cases run concurrently.
// Each case starts several child processes. Bound overlap so setup can reach
// the deliberately hung command before the deadline being tested expires.
describe("CI k3d preparation", { concurrency: 4 }, () => {
  registerBuildKitCases();
  registerFixtureBuildDeadlineCases();
  registerVerifiedRuntimePublicationCase();
  registerClusterBootstrapCases();
  registerClusterCreateCases();
  registerBoundedNodeLogCases();
  registerFixtureStorageCases();
  registerHostImageCustodyCases();
  registerClusterImageImportCases();
});

registerNodeLogChronologyCases();
registerAgentSandboxImageCustodyCase();

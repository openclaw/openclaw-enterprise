// The embedded Gateway restarted on its retained state after an unclean stop,
// recovered by Docker Compute's handoff and by a restarted container in the same
// Kubernetes Pod. The operator-confirmed recovery and the Docker Compute
// replacement are in runtime-image-gateway-retained-state.test.mjs, which CI runs
// in another lane.
import { uncleanStopRestartTest } from "../helpers/runtime-image-gateway-restart.mjs";

uncleanStopRestartTest(
  "Docker",
  "runtime image embedded Gateway restarted after an unclean stop is ready only when its agent takes turns",
);
uncleanStopRestartTest(
  "Kubernetes",
  "an embedded Gateway container restarted in the same Kubernetes Pod recovers its first owner",
);

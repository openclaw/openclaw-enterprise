// The embedded Gateway restarted on its retained state after an unclean stop,
// recovered by Docker Compute's handoff and by a restarted container in the same
// Kubernetes Pod, and replaced by a new Pod after a stop ended it mid-startup.
// The operator-confirmed recovery and the Docker Compute replacement are in
// runtime-image-gateway-retained-state.test.ts, which CI runs in another lane.
import {
  liveHolderKeepsStateTest,
  stoppedStarterReplacementTest,
  uncleanStopRestartTest,
} from "../helpers/runtime-image-gateway-restart.ts";

uncleanStopRestartTest(
  "Docker",
  "runtime image embedded Gateway restarted after an unclean stop is ready only when its agent takes turns",
);
uncleanStopRestartTest(
  "Kubernetes",
  "an embedded Gateway container restarted in the same Kubernetes Pod recovers its first owner",
);
stoppedStarterReplacementTest(
  "a new Gateway Pod starts on state whose previous Gateway was stopped while it took its state lock",
);
liveHolderKeepsStateTest(
  "a Gateway that exits beside a live Gateway on the same state leaves that Gateway's lock in place",
);

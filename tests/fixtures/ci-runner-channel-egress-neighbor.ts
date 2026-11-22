import test from "node:test";
import { channelEgressCase } from "../../scripts/ci/channel-egress-diagnostic.ts";

test(channelEgressCase.title, () => {
  throw Object.assign(new Error("synthetic failure"), {
    openclawCiDiagnostic: { kind: "channel-egress", stage: "active-tunnel" },
  });
});

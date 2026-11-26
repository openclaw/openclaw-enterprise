import test from "node:test";
import { runHelmChannelScenario } from "../helpers/channel-egress-helm-scenario.ts";

const selected = process.env.OCC_TEST_CHANNEL_EGRESS_UPGRADE === "1";
test(
  "one-off channel upgrade deploys current drafts and verifies real model and Slack recovery",
  {
    skip: selected ? false : "Select the explicit channel-egress-upgrade QA scenario.",
    timeout: 1_800_000,
  },
  (t) => runHelmChannelScenario(t, { upgrade: true }),
);

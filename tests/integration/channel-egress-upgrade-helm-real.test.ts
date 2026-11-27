import test from "node:test";
import { runHelmChannelScenario } from "../helpers/channel-egress-helm-scenario.ts";

const selected = process.env.OCC_TEST_CHANNEL_EGRESS_UPGRADE === "1";
test(
  "one-off channel upgrade stops legacy Slack and recovers a channel-free Agent with a real model turn",
  {
    skip: selected ? false : "Select the explicit channel-egress-upgrade QA scenario.",
    timeout: 1_800_000,
  },
  (t) => runHelmChannelScenario(t, { upgrade: true }),
);

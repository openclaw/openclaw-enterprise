import test from "node:test";
import { runHelmChannelScenario } from "../helpers/channel-egress-helm-scenario.ts";

const selected = process.env.OCC_TEST_SLACK_LIVE === "1";
test(
  "Helm-installed OCC and PostgreSQL deploy isolated Slack routing through real model cutover",
  {
    skip: selected ? false : "Select the credentialed Slack Kubernetes lane.",
    timeout: 1_800_000,
  },
  (t) => runHelmChannelScenario(t, { upgrade: false }),
);

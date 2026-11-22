import test from "node:test";
import {
  channelEgressCase,
  withChannelEgressStage,
} from "../../scripts/ci/channel-egress-diagnostic.ts";

const { title } = channelEgressCase;

function failWithDiagnostic(diagnostic: { stage: string; extra?: string }): never {
  throw Object.assign(new Error("synthetic failure"), {
    openclawCiDiagnostic: { kind: "channel-egress", ...diagnostic },
  });
}

test(
  title,
  withChannelEgressStage(async (_t, setStage) => {
    setStage("connect-routing");
    throw new Error("synthetic route");
  }),
);

test(
  title,
  withChannelEgressStage(async (_t, setStage) => {
    setStage("active-tunnel");
    throw new Error("synthetic tunnel");
  }),
);

test(title, () => failWithDiagnostic({ stage: "fixture-unrecognized-stage" }));
test(title, () => failWithDiagnostic({ stage: "active-tunnel", extra: "fixture-extra-field" }));
test("other title", () => failWithDiagnostic({ stage: "active-tunnel" }));
test("parent", async (t) => {
  await t.test(title, () => failWithDiagnostic({ stage: "active-tunnel" }));
});
test(title, () => {});

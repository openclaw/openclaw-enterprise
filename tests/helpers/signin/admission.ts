import assert from "node:assert/strict";
import type { TransitionFixture } from "./transition.ts";

type Admission<Image> = Pick<
  TransitionFixture<Image, never>,
  "canAdmit" | "images" | "assertExclusiveDisposable"
>;
type Candidate = Parameters<Admission<never>["canAdmit"]>[0];
type Clock = () => Promise<number | null>;

// All writes to the operator's admission marker pass this boundary.
export function signinAdmission<Image>({
  canAdmit,
  gate,
  images,
  attest,
  selectedTarget,
  assertCustody,
}: Pick<Admission<Image>, "canAdmit" | "images"> & {
  gate: Pick<TransitionFixture<Image, never>, "assertClosedRoutes"> & {
    openTarget: () => Promise<void>;
  };
  attest: Clock;
  selectedTarget: () => Promise<Exclude<Candidate, "unknown">>;
  assertCustody: Admission<Image>["assertExclusiveDisposable"];
}) {
  async function open(target: Candidate, clock = attest) {
    await gate.assertClosedRoutes();
    const skew = await clock();
    if (!canAdmit(target, images, skew)) {
      throw new Error("refused sign-in admission");
    }
    await assertCustody();
    assert.equal(await selectedTarget(), target);
    await gate.openTarget();
  }
  return {
    openTarget: open,
    async refusalControls(probe: () => Promise<void>) {
      for (const [target, clock] of [
        ["unknown", attest],
        ["P", async () => null],
      ] as const) {
        await assert.rejects(() => open(target, clock), /^Error: refused sign-in admission$/);
        await gate.assertClosedRoutes();
        await probe();
        assert.equal(await selectedTarget(), "P");
      }
    },
  };
}

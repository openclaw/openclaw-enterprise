import assert from "node:assert/strict";

// All writes to the operator's admission marker pass this boundary.
export function signinAdmission({ canAdmit, gate, images, attest, selectedTarget, assertCustody }) {
  async function open(target, clock = attest) {
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
    async refusalControls(probe) {
      for (const [target, clock] of [
        ["unknown", attest],
        ["P", async () => null],
      ]) {
        await assert.rejects(() => open(target, clock), /^Error: refused sign-in admission$/);
        await gate.assertClosedRoutes();
        await probe();
        assert.equal(await selectedTarget(), "P");
      }
    },
  };
}

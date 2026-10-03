import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventOperationPlanAdapter,
  EventOperationPlanUnavailable,
} from "../../packages/occ/src/state/event-operation-plan.ts";

function expectation() {
  return {
    literalInput: "An exact human sentence.\n",
    binding: {
      installationId: "installation-1",
      userId: "user-1",
      accountIncarnation: "account-2",
      principalId: "principal-1",
      participantIncarnation: "participant-3",
      sessionId: "session-1",
      sessionIncarnation: "session-4",
      eventRef: "event-1",
      eventRevision: "event-5",
      grantId: "grant-1",
      grantRevision: "grant-6",
      namespaceId: "namespace-1",
      agentId: "agent-1",
      agentRevision: "agent-7",
      conversationId: "conversation-1",
      conversationIncarnation: "conversation-8",
      targetSessionId: "gateway-session-1",
      selectedEntryId: "entry-1",
      selectedEntryGeneration: "entry-9",
      operationId: "operation-1",
      requestId: "request-1",
      inputDigest: "owner-selected-input-commitment",
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// This fixture exercises ONLY the conditional adapter port. Its opaque maps are
// not an authentication issuer, PostgreSQL implementation or real turn journal.
// No source test below qualifies any of those unavailable production suppliers.
function protocolOwner() {
  const unit = Object.freeze({});
  const witness = Object.freeze({});
  const loss = new AbortController();
  const state = {
    expected: expectation(),
    loss,
    outcome: "completed",
    settlement: "acknowledged",
    calls: 0,
  };
  const scopes = new WeakMap();
  const settlements = new WeakMap();
  const statuses = new WeakMap();
  const owner = {
    async withOriginalRequest(selectedUnit, selectedWitness, work) {
      state.calls++;
      if (selectedUnit !== unit || selectedWitness !== witness) {
        throw new Error("unrecognized original witness");
      }
      const scope = Object.freeze({});
      scopes.set(scope, selectedUnit);
      if (state.skip) {
        return Object.freeze({});
      }
      const pending = work(scope);
      if (state.early) {
        state.pending = pending.catch(() => {});
      } else {
        await pending;
      }
      if (state.twice) {
        try {
          await work(scope);
        } catch {
          // The adversarial owner swallows rejection; the adapter must stay poisoned.
        }
      }
      if (state.commitLoss) {
        throw new Error("unknown physical settlement");
      }
      const receipt = Object.freeze({});
      settlements.set(receipt, scope);
      return state.forgedSettlement ? Object.freeze({}) : receipt;
    },
    inspectOriginalRequest(selectedUnit, scope) {
      if (scopes.get(scope) !== selectedUnit) {
        throw new Error("unrecognized scope");
      }
      return {
        ...state.expected,
        unit: state.replacementUnit ?? unit,
        lost: state.loss.signal,
      };
    },
    inspectSettlement(selectedUnit, scope, receipt) {
      if (state.abortOnSettlement) {
        state.loss.abort();
      }
      return scopes.get(scope) === selectedUnit && settlements.get(receipt) === scope
        ? "committed"
        : "unknown";
    },
    async readOriginalStatus(selectedUnit, scope) {
      if (scopes.get(scope) !== selectedUnit) {
        throw new Error("unrecognized status scope");
      }
      if (state.readWait) {
        await state.readWait.promise;
      }
      if (state.missing) {
        return undefined;
      }
      const receipt = Object.freeze({});
      statuses.set(receipt, {
        scope,
        projection: {
          ...(state.statusExpected ?? state.expected),
          outcome: state.outcome,
          settlement: state.settlement,
        },
      });
      return state.forgedStatus ? Object.freeze({}) : receipt;
    },
    inspectOriginalStatus(selectedUnit, scope, receipt) {
      const value = statuses.get(receipt);
      return scopes.get(scope) === selectedUnit && value?.scope === scope
        ? value.projection
        : undefined;
    },
  };
  return {
    unit,
    witness,
    state,
    adapter: createEventOperationPlanAdapter(owner),
  };
}

test("missing custody and structural plans cannot establish event authority", async () => {
  const adapter = createEventOperationPlanAdapter();
  let called = false;
  const result = await adapter.withPlan({}, {}, expectation(), async () => {
    called = true;
  });
  assert.equal(result.status, "unknown");
  assert.equal(called, false);
  await assert.rejects(adapter.claimEventOperation({}, {}), EventOperationPlanUnavailable);
  assert.equal((await adapter.originalStatus({}, {}, expectation())).status, "unknown");
});

test("one recognized conditional scope yields one plan only in its original unit", async () => {
  const { adapter, unit, witness, state } = protocolOwner();
  let leaked;
  const result = await adapter.withPlan(unit, witness, expectation(), async (plan) => {
    leaked = plan;
    await assert.rejects(adapter.claimEventOperation({}, plan), EventOperationPlanUnavailable);
    await assert.rejects(
      adapter.claimEventOperation(unit, { ...plan }),
      EventOperationPlanUnavailable,
    );
    await assert.rejects(
      createEventOperationPlanAdapter().claimEventOperation(unit, plan),
      EventOperationPlanUnavailable,
    );
    const binding = await adapter.claimEventOperation(unit, plan);
    assert.deepEqual({ ...binding }, expectation().binding);
    await assert.rejects(adapter.claimEventOperation(unit, plan), EventOperationPlanUnavailable);
    return "original-unit-result";
  });
  assert.equal(result.status, "committed");
  assert.equal(result.value, "original-unit-result");
  await assert.rejects(adapter.claimEventOperation(unit, leaked), EventOperationPlanUnavailable);
  assert.equal(
    (
      await adapter.withPlan(unit, witness, expectation(), async () =>
        assert.fail("replayed witness"),
      )
    ).status,
    "unknown",
  );
  assert.equal(state.calls, 1);
});

test("every original identity, grant, target and generation comparison fails closed", async (t) => {
  for (const field of Object.keys(expectation().binding)) {
    await t.test(field, async () => {
      const { adapter, unit, witness } = protocolOwner();
      const expected = expectation();
      expected.binding[field] += "-different";
      let called = false;
      assert.equal(
        (
          await adapter.withPlan(unit, witness, expected, async () => {
            called = true;
          })
        ).status,
        "unknown",
      );
      assert.equal(called, false);
    });
  }
});

test("literal input is not normalized and accessor or malformed comparisons are refused", async () => {
  for (const literalInput of [
    "An exact human sentence.",
    "an exact human sentence.\n",
    "",
    "\ud800",
  ]) {
    const { adapter, unit, witness } = protocolOwner();
    const result = await adapter.withPlan(
      unit,
      witness,
      { ...expectation(), literalInput },
      async () => assert.fail("changed literal"),
    );
    assert.equal(result.status, "unknown");
  }
  const { adapter, unit, witness } = protocolOwner();
  let getters = 0;
  const expected = {
    ...expectation(),
    get binding() {
      getters++;
      return expectation().binding;
    },
  };
  assert.equal(
    (await adapter.withPlan(unit, witness, expected, async () => assert.fail("accessor"))).status,
    "unknown",
  );
  assert.equal(getters, 0);
});

test("literal validation preserves well-formed UTF-16 without requiring the newer String method", async () => {
  async function checkLiteral(literalInput, accepted) {
    const { adapter, unit, witness, state } = protocolOwner();
    state.expected = { ...state.expected, literalInput };
    let consumed = false;
    const result = await adapter.withPlan(unit, witness, state.expected, async (plan) => {
      await adapter.claimEventOperation(unit, plan);
      consumed = true;
    });
    assert.equal(result.status, accepted ? "committed" : "unknown");
    assert.equal(consumed, accepted);
    assert.equal(state.calls, accepted ? 1 : 0);
  }

  // Preserve the original character policy: this checks encoding, not allowed text.
  for (const literal of ["\u0000", "\ud7ff", "\ue000", "\uffff", "x😀y"]) {
    await checkLiteral(literal, true);
  }
  for (const literal of [
    "\ud800a",
    "a\ud800",
    "\ud800\ud800",
    "\udc00\ud800",
    "\ud800\udc00\ud800",
    "\ud800\udc00\udc00",
  ]) {
    await checkLiteral(literal, false);
  }
  // Every surrogate is invalid alone and valid in its corresponding pair position.
  for (let unit = 0xd800; unit <= 0xdfff; unit += 1) {
    const surrogate = String.fromCharCode(unit);
    await checkLiteral(surrogate, false);
    await checkLiteral(unit <= 0xdbff ? `${surrogate}\udc00` : `\ud800${surrogate}`, true);
  }
});

test("withdrawal, session replacement and lost original unit after a wait hide the result", async (t) => {
  for (const change of ["withdrawal", "session", "unit"]) {
    await t.test(change, async () => {
      const { adapter, unit, witness, state } = protocolOwner();
      const gate = deferred();
      const entered = deferred();
      const pending = adapter.withPlan(unit, witness, expectation(), async (plan) => {
        await adapter.claimEventOperation(unit, plan);
        entered.resolve();
        await gate.promise;
        return "must-not-escape";
      });
      await entered.promise;
      if (change === "withdrawal") {
        state.loss.abort();
      }
      if (change === "session") {
        state.expected.binding.sessionIncarnation = "replaced-session";
      }
      if (change === "unit") {
        state.replacementUnit = {};
      }
      gate.resolve();
      const result = await pending;
      assert.equal(result.status, "unknown");
      assert.equal(Object.hasOwn(result, "value"), false);
    });
  }
});

test("scope loss before consumption refuses the plan and remains unknown", async () => {
  const { adapter, unit, witness, state } = protocolOwner();
  const result = await adapter.withPlan(unit, witness, expectation(), async (plan) => {
    state.loss.abort();
    await assert.rejects(adapter.claimEventOperation(unit, plan), EventOperationPlanUnavailable);
    return "hidden";
  });
  assert.equal(result.status, "unknown");
});

test("unknown COMMIT or forged settlement does not expose work or permit witness replay", async (t) => {
  for (const failure of ["commitLoss", "forgedSettlement"]) {
    await t.test(failure, async () => {
      const { adapter, unit, witness, state } = protocolOwner();
      state[failure] = true;
      const result = await adapter.withPlan(unit, witness, expectation(), async (plan) => {
        await adapter.claimEventOperation(unit, plan);
        return { cookie: "not-published" };
      });
      assert.equal(result.status, "unknown");
      assert.equal(Object.hasOwn(result, "value"), false);
      assert.equal(
        (await adapter.withPlan(unit, witness, expectation(), async () => assert.fail("retry")))
          .status,
        "unknown",
      );
      assert.equal(state.calls, 1);
    });
  }
});

test("missing, repeated or prematurely detached owner callbacks cannot manufacture success", async (t) => {
  for (const failure of ["skip", "twice", "early"]) {
    await t.test(failure, async () => {
      const { adapter, unit, witness, state } = protocolOwner();
      state[failure] = true;
      let calls = 0;
      let plan;
      const gate = deferred();
      const result = await adapter.withPlan(unit, witness, expectation(), async (value) => {
        calls++;
        plan = value;
        if (failure === "early") {
          await gate.promise;
        }
        return "not-committed";
      });
      assert.equal(result.status, "unknown");
      assert.ok(calls <= 1);
      if (plan) {
        await assert.rejects(
          adapter.claimEventOperation(unit, plan),
          EventOperationPlanUnavailable,
        );
      }
      gate.resolve();
      await state.pending;
    });
  }
});

test("exact original status requires owner-recognized receipts and both acknowledged settlements", async (t) => {
  for (const outcome of ["pending", "completed", "failed"]) {
    await t.test(outcome, async () => {
      const { adapter, unit, witness, state } = protocolOwner();
      state.outcome = outcome;
      const result = await adapter.originalStatus(unit, witness, expectation());
      assert.equal(result.status, "known");
      assert.equal(result.outcome, outcome);
    });
  }
  for (const failure of [
    "missing",
    "forgedStatus",
    "commitLoss",
    "forgedSettlement",
    "originalUnknown",
    "wrongOriginal",
    "wrongLiteral",
  ]) {
    await t.test(failure, async () => {
      const { adapter, unit, witness, state } = protocolOwner();
      if (failure === "originalUnknown") {
        state.settlement = "unknown";
      } else if (failure === "wrongOriginal") {
        state.statusExpected = expectation();
        state.statusExpected.binding.operationId = "other-operation";
      } else if (failure === "wrongLiteral") {
        state.statusExpected = expectation();
        state.statusExpected.literalInput = "other input";
      } else {
        state[failure] = true;
      }
      assert.equal((await adapter.originalStatus(unit, witness, expectation())).status, "unknown");
    });
  }
});

test("withdrawal while exact-original status is pending suppresses disclosure", async () => {
  const { adapter, unit, witness, state } = protocolOwner();
  state.readWait = deferred();
  const pending = adapter.originalStatus(unit, witness, expectation());
  state.loss.abort();
  state.readWait.resolve();
  assert.equal((await pending).status, "unknown");
});

test("a serialized original witness is not admitted by the selected owner", async () => {
  const { adapter, unit, witness } = protocolOwner();
  const result = await adapter.withPlan(unit, { ...witness }, expectation(), async () =>
    assert.fail("forged witness"),
  );
  assert.equal(result.status, "unknown");
});

test("settlement inspection cannot publish a result after scope loss", async () => {
  const { adapter, unit, witness, state } = protocolOwner();
  state.abortOnSettlement = true;
  const result = await adapter.withPlan(unit, witness, expectation(), async (plan) => {
    await adapter.claimEventOperation(unit, plan);
    return "hidden-after-loss";
  });
  assert.equal(result.status, "unknown");
  assert.equal(Object.hasOwn(result, "value"), false);
});

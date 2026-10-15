import assert from "node:assert/strict";

export async function assertSpentDeviceProofRefusal({ installReader, signIn, knownDeviceOf }) {
  // Hold two admitted readers before their genuine database operation. A third
  // request must finish through refusal, not enter another reader and later return
  // 429 merely because the device's password allowance was already spent.
  const releaseReads = Promise.withResolvers();
  const twoReads = Promise.withResolvers();
  const thirdRead = Promise.withResolvers();
  let readCount = 0;
  let completedReads = 0;
  const pending = [];
  let settled;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), 10_000);
  });
  const holdRead = async (read) => {
    readCount += 1;
    if (readCount === 2) {
      twoReads.resolve({ kind: "two-reads" });
    } else if (readCount > 2) {
      thirdRead.resolve({ kind: "third-read" });
    }
    await releaseReads.promise;
    const result = await read();
    completedReads += 1;
    return result;
  };
  const reader = installReader(holdRead);
  const launch = () => {
    const request = Promise.resolve(signIn()).then(
      (response) => ({ kind: "response", response }),
      (error) => ({ kind: "request-error", error }),
    );
    pending.push(request);
    return request;
  };
  try {
    launch();
    launch();
    const started = await Promise.race([twoReads.promise, ...pending, deadline]);
    if (started.kind === "request-error") {
      throw started.error;
    }
    assert.equal(started.kind, "two-reads", "both admitted readers must be held");
    const refused = await Promise.race([thirdRead.promise, launch(), deadline]);
    if (refused.kind === "request-error") {
      throw refused.error;
    }
    assert.equal(
      refused.kind,
      "response",
      "proof refusal must answer without admitting a third account-state read",
    );
    assert.equal(readCount, 2, "refused proof never reaches the account-state reader");
    assert.equal(refused.response.statusCode, 429, refused.response.body);
    assert.equal(knownDeviceOf(refused.response), undefined, "refusal issues no device");
  } finally {
    // Never abandon the injected requests or leave the real reader wrapped after a
    // failed assertion (including the genuine unbounded-reader negative control).
    clearTimeout(timer);
    releaseReads.resolve();
    try {
      settled = await Promise.all(pending);
    } finally {
      reader.mock.restore();
    }
  }
  assert.equal(readCount, 2);
  assert.equal(completedReads, 2, "both held reads completed their real database work");
  for (const result of settled) {
    if (result.kind === "request-error") {
      throw result.error;
    }
    assert.equal(result.response.statusCode, 429, result.response.body);
  }
}

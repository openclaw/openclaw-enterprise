import assert from "node:assert/strict";
import test from "node:test";
import {
  sandboxRepositoryMaterialExpectation,
  sandboxRepositoryMaterialReady,
} from "../../apps/controller/src/drivers/compute/kubernetes/sandbox-repository-material.ts";
import {
  REPOSITORY_MATERIAL_ROOT,
  repositoryMaterialDeployment,
  repositoryMaterialSpec,
} from "../../apps/controller/src/drivers/compute/kubernetes/repository-material.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";

// The existing session encoder/generation producer and new consumer are real.
// Provider recipient/inspection ports are controlled: no OpenShell delivery,
// upstream fields, Kubernetes ownership authentication or live readiness is proved.
function fixture() {
  let time = Date.now();
  const deadlineWallMs = time + 60_000;
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000001",
    namespaceId: "ns_00000000-0000-4000-8000-000000000001",
    agentId: "agt_00000000-0000-4000-8000-000000000001",
    harness: { id: "codex", mode: "dedicated" },
    repositoryCredentials: {
      deadlineWallMs,
      bindings: [{ repositoryRef: "project" }, { repositoryRef: "tools" }],
    },
  };
  const client = {
    gatewayOrigin: "https://git.credentials.example.test",
    gitRemote: "https://git.credentials.example.test/example/project.git",
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: "git.credentials.example.test",
    repository: "example/project",
  };
  const bindings = ["tools", "project"].map((repositoryRef, index) => {
    const sessionId = `session_${repositoryRef}`;
    const deadline = deadlineWallMs - index * 1_000;
    return {
      kind: "new",
      repositoryRef,
      sessionId,
      deadlineWallMs: deadline,
      files: encodeRepositoryCredentialSessionFiles({
        session: { sessionId, deadlineWallMs: deadline },
        bearer: `controlled_gateway_session_${repositoryRef}_00000000000000000000`,
        client,
      }),
    };
  });
  const sandbox = {
    namespaceName: "openclaw-test",
    resourceName: "sandbox-material",
    agentId: revision.agentId,
    revisionId: revision.id,
  };
  const expected = sandboxRepositoryMaterialExpectation(revision, bindings, sandbox);
  const selected = {
    sandbox,
    pod: {
      namespaceName: sandbox.namespaceName,
      resourceName: "provider-harness",
      uid: "00000000-0000-4000-8000-000000000002",
      role: "agent",
    },
  };
  let current = {
    recipient: structuredClone(selected),
    generation: expected.generation,
    deadlineWallMs: expected.deadlineWallMs,
  };
  const observation = {
    recipient: structuredClone(selected),
    podReady: true,
    material: {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      generation: expected.generation,
      bindings: expected.bindings.map(({ repositoryRef, sessionId, deadlineWallMs }) => ({
        repositoryRef,
        sessionId,
        deadlineWallMs,
      })),
      storage: {
        medium: "Memory",
        sizeLimit: "4Mi",
        mountPath: REPOSITORY_MATERIAL_ROOT,
        readOnly: true,
      },
      completedStages: ["validated", "published", "native-git-prepared"],
    },
  };
  const abort = new AbortController();
  const bounds = { signal: abort.signal, deadlineWallMs };
  let inspections = 0;
  const observer = {
    currentSelection: () => current,
    async inspect(received, generation, receivedBounds) {
      inspections += 1;
      assert.deepEqual(received, selected);
      assert.equal(generation, expected.generation);
      assert.equal(receivedBounds.signal, abort.signal);
      assert.equal(
        receivedBounds.deadlineWallMs,
        Math.min(bounds.deadlineWallMs, expected.deadlineWallMs),
      );
      return observation;
    },
  };
  return {
    revision,
    bindings,
    sandbox,
    expected,
    selected,
    observation,
    observer,
    bounds,
    abort,
    now: () => time,
    setTime: (value) => {
      time = value;
    },
    setCurrent: (value) => {
      current = value === undefined ? undefined : { ...current, recipient: value };
    },
    setGeneration: (value) => {
      current.generation = value;
    },
    setDeadline: (value) => {
      current.deadlineWallMs = value;
    },
    inspections: () => inspections,
    check: () => sandboxRepositoryMaterialReady(expected, observer, bounds, () => time),
  };
}

function fixtureWithRecipientUid(uid) {
  const f = fixture();
  f.selected.pod.uid = uid;
  f.setCurrent(structuredClone(f.selected));
  f.observation.recipient.pod.uid = uid;
  return f;
}

for (const code of [...Array.from({ length: 33 }, (_, index) => index), 0x7f]) {
  test(`current recipient rejects U+${code.toString(16).padStart(4, "0")} before inspection`, async () => {
    const f = fixtureWithRecipientUid(`pod${String.fromCharCode(code)}uid`);
    assert.equal(await f.check(), false);
    assert.equal(f.inspections(), 0);
  });
}

for (const [label, uid] of [
  ["lower printable boundary", "!"],
  ["upper printable boundary", "~"],
  ["first non-ASCII code unit", "\u0080"],
  ["non-ASCII whitespace", "\u00a0"],
  ["surrogate pair", "pod-\u{1f600}"],
  ["256 code units", "x".repeat(256)],
  ["256 code units including surrogate pairs", "\u{1f600}".repeat(128)],
]) {
  test(`matching component recipient preserves ${label}`, async () => {
    const f = fixtureWithRecipientUid(uid);
    assert.equal(await f.check(), true);
    assert.equal(f.inspections(), 1);
  });
}

for (const [label, uid] of [
  ["undefined", undefined],
  ["null", null],
  ["number", 42],
  ["boolean", false],
  ["object", {}],
  ["array", []],
  ["empty string", ""],
  ["257 code units", "x".repeat(257)],
  ["257 code units including surrogate pairs", `${"\u{1f600}".repeat(128)}x`],
]) {
  test(`current recipient rejects ${label} before inspection`, async () => {
    const f = fixtureWithRecipientUid(uid);
    assert.equal(await f.check(), false);
    assert.equal(f.inspections(), 0);
  });
}

test("expectation reuses original sessions, generation and private material locations", () => {
  const f = fixture();
  const original = repositoryMaterialSpec(f.revision, f.bindings);
  const rendered = repositoryMaterialDeployment(original, "runtime-image");
  const init = JSON.parse(rendered.initContainers[0].args[1]);
  assert.equal(f.expected.generation, original.generation);
  assert.equal(f.expected.generation, init.manifest.generation);
  assert.deepEqual(
    f.expected.bindings.map((binding) => binding.sessionId),
    ["session_project", "session_tools"],
  );
  assert.equal(
    f.expected.deadlineWallMs,
    Math.min(...f.bindings.map((binding) => binding.deadlineWallMs)),
  );
  assert.deepEqual(rendered.volumes[1].emptyDir, { medium: "Memory", sizeLimit: "4Mi" });
  assert.equal(rendered.volumeMounts[0].readOnly, true);
  assert.equal(rendered.volumeMounts[0].mountPath, REPOSITORY_MATERIAL_ROOT);
  assert.deepEqual(
    rendered.initContainers.map((step) => step.name),
    ["prepare-repository-material", "prepare-repository-native-git"],
  );
  for (const binding of f.expected.bindings) {
    const source = original.bindings.find((item) => item.repositoryRef === binding.repositoryRef);
    assert.equal(binding.secretName, source.secretName);
    assert.equal(binding.directory, source.directory);
  }
  const serialized = JSON.stringify(f.expected);
  assert.ok(!serialized.includes("controlled_gateway_session"));
  assert.ok(!serialized.includes("oauth_token"));
  assert.ok(!serialized.includes("client.json"));
  assert.ok(Object.isFrozen(f.expected));
  assert.ok(Object.isFrozen(f.expected.bindings[0]));
});

test("retained bindings preserve the same original generation without copying material files", () => {
  const f = fixture();
  const retained = f.bindings.map(({ repositoryRef, sessionId, deadlineWallMs }) => ({
    kind: "retained",
    repositoryRef,
    sessionId,
    deadlineWallMs,
  }));
  assert.deepEqual(
    sandboxRepositoryMaterialExpectation(f.revision, retained, f.sandbox),
    f.expected,
  );
});

test("ordinary revisions without repository bindings produce no material expectation", () => {
  const f = fixture();
  assert.equal(
    sandboxRepositoryMaterialExpectation(
      { ...f.revision, repositoryCredentials: undefined },
      undefined,
      f.sandbox,
    ),
    undefined,
  );
});

test("mismatched Sandbox scope and unsupported Harness profiles cannot create an expectation", () => {
  const f = fixture();
  assert.throws(() =>
    sandboxRepositoryMaterialExpectation(f.revision, f.bindings, {
      ...f.sandbox,
      agentId: "other",
    }),
  );
  assert.throws(() =>
    sandboxRepositoryMaterialExpectation(f.revision, f.bindings, {
      ...f.sandbox,
      revisionId: "other",
    }),
  );
  assert.throws(() =>
    sandboxRepositoryMaterialExpectation(
      { ...f.revision, harness: { id: "openclaw", mode: "embedded" } },
      f.bindings,
      f.sandbox,
    ),
  );
});

test("original producer rejects mismatched session files before an expectation is published", () => {
  const f = fixture();
  const corrupt = structuredClone(f.bindings);
  corrupt[1].files["client.json"] = corrupt[0].files["client.json"];
  assert.throws(() => sandboxRepositoryMaterialExpectation(f.revision, corrupt, f.sandbox));
});

test("matching controlled owner inspection satisfies the proposed consumer comparison", async () => {
  const f = fixture();
  assert.equal(await f.check(), true);
  assert.equal(f.inspections(), 1);
});

test("missing provider capability never substitutes a Ready Pod", async () => {
  const f = fixture();
  assert.equal(await sandboxRepositoryMaterialReady(f.expected, undefined, f.bounds, f.now), false);
  assert.equal(f.inspections(), 0);
});

const invalidObservations = {
  "raw Ready Pod": (f) => {
    f.observer.inspect = async () => ({
      metadata: { labels: {} },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
  },
  "missing material": (f) => {
    f.observation.material = undefined;
  },
  "unready Pod": (f) => {
    f.observation.podReady = false;
  },
  "wrong generation": (f) => {
    f.observation.material.generation = "a".repeat(64);
  },
  "wrong Namespace": (f) => {
    f.observation.material.namespaceId = "another-namespace";
  },
  "wrong Agent": (f) => {
    f.observation.material.agentId = "another-agent";
  },
  "wrong revision": (f) => {
    f.observation.material.revisionId = "another-revision";
  },
  "wrong Sandbox owner": (f) => {
    f.observation.recipient.sandbox.resourceName = "another-sandbox";
  },
  "wrong Pod UID": (f) => {
    f.observation.recipient.pod.uid = "another-uid";
  },
  "Gateway recipient": (f) => {
    f.observation.recipient.pod.role = "gateway";
  },
  "missing session": (f) => {
    f.observation.material.bindings.pop();
  },
  "duplicate session": (f) => {
    f.observation.material.bindings[1] = f.observation.material.bindings[0];
  },
  "stale session": (f) => {
    f.observation.material.bindings[0].sessionId = "previous-session";
  },
  "different session deadline": (f) => {
    f.observation.material.bindings[0].deadlineWallMs += 1;
  },
  "unbounded binding list": (f) => {
    f.observation.material.bindings = Array(17).fill(f.observation.material.bindings[0]);
  },
  "PVC material": (f) => {
    f.observation.material.storage.medium = "PersistentVolumeClaim";
  },
  "unbounded storage": (f) => {
    f.observation.material.storage.sizeLimit = "1Gi";
  },
  "writable Agent material": (f) => {
    f.observation.material.storage.readOnly = false;
  },
  "public material path": (f) => {
    f.observation.material.storage.mountPath = "/workspace";
  },
  "missing validation": (f) => {
    f.observation.material.completedStages = ["published", "native-git-prepared"];
  },
  "publication before validation": (f) => {
    f.observation.material.completedStages = ["published", "validated", "native-git-prepared"];
  },
  "missing native Git preparation": (f) => {
    f.observation.material.completedStages = ["validated", "published"];
  },
  "extra preparation passthrough": (f) => {
    f.observation.material.completedStages.push("arbitrary-init");
  },
};
for (const [name, change] of Object.entries(invalidObservations)) {
  test(`${name} cannot pass repository readiness`, async () => {
    const f = fixture();
    change(f);
    assert.equal(await f.check(), false);
  });
}

test("all original sessions are compared without depending on observation ordering", async () => {
  const f = fixture();
  f.observation.material.bindings.reverse();
  assert.equal(await f.check(), true);
});

for (const action of [
  "stop",
  "replace",
  "generation",
  "deadline",
  "abort",
  "expire",
  "shorten-bounds",
  "replace-port",
]) {
  test(`${action} during inspection invalidates the result after await`, async () => {
    const f = fixture();
    const inspect = f.observer.inspect;
    f.observer.inspect = async (...args) => {
      const result = await inspect(...args);
      if (action === "stop") {
        f.setCurrent(undefined);
      } else if (action === "replace") {
        const successor = structuredClone(f.selected);
        successor.pod.uid = "successor-uid";
        f.setCurrent(successor);
      } else if (action === "generation") {
        f.setGeneration("b".repeat(64));
      } else if (action === "deadline") {
        f.setDeadline(f.expected.deadlineWallMs - 1);
      } else if (action === "abort") {
        f.abort.abort();
      } else if (action === "expire") {
        f.setTime(f.expected.deadlineWallMs);
      } else if (action === "shorten-bounds") {
        f.bounds.deadlineWallMs = f.now();
      } else {
        f.observer.currentSelection = () => undefined;
      }
      return result;
    };
    assert.equal(await f.check(), false);
    assert.equal(f.inspections(), 1);
  });
}

test("a changed current material selection denies before inspection despite the same Pod", async () => {
  for (const field of ["generation", "deadline"]) {
    const f = fixture();
    if (field === "generation") {
      f.setGeneration("b".repeat(64));
    } else {
      f.setDeadline(f.expected.deadlineWallMs - 1);
    }
    assert.equal(await f.check(), false);
    assert.equal(f.inspections(), 0);
  }
});

test("a stopped owner and an expired/aborted call are denied before inspection", async () => {
  for (const state of ["stopped", "expired", "aborted"]) {
    const f = fixture();
    if (state === "stopped") {
      f.setCurrent(undefined);
    } else if (state === "expired") {
      f.setTime(f.expected.deadlineWallMs);
    } else {
      f.abort.abort();
    }
    assert.equal(await f.check(), false);
    assert.equal(f.inspections(), 0);
  }
});

test("read-only inspection failure has no automatic replay", async () => {
  const f = fixture();
  let calls = 0;
  f.observer.inspect = async () => {
    calls += 1;
    throw new Error("inspection outcome unavailable");
  };
  assert.equal(await f.check(), false);
  assert.equal(calls, 1);
});

test("a mutable expectation cannot extend the captured generation or deadline during await", async () => {
  const f = fixture();
  const expected = structuredClone(f.expected);
  f.observer.inspect = async () => {
    expected.deadlineWallMs += 60_000;
    expected.generation = "b".repeat(64);
    f.observation.material.generation = expected.generation;
    f.setTime(f.expected.deadlineWallMs);
    return f.observation;
  };
  assert.equal(await sandboxRepositoryMaterialReady(expected, f.observer, f.bounds, f.now), false);
});

test("observation accessors and proxies are rejected without executing them", async () => {
  for (const mode of ["accessor", "proxy"]) {
    const f = fixture();
    let touched = false;
    const value =
      mode === "proxy"
        ? new Proxy(f.observation, {
            ownKeys() {
              touched = true;
              return Reflect.ownKeys(f.observation);
            },
          })
        : { ...f.observation };
    if (mode === "accessor") {
      Object.defineProperty(value, "material", {
        get() {
          touched = true;
          return f.observation.material;
        },
      });
    }
    f.observer.inspect = async () => value;
    assert.equal(await f.check(), false);
    assert.equal(touched, false);
  }
});

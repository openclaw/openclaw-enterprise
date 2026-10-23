// Preloaded into scripts/ci/run-tests.mjs (node --import) by ci-runner tests that wait out a
// lane deadline, so a busy host cannot make them fail (finding 2164). The runner's clock
// (Date.now and setTimeout) runs as usual up to the `hold` time in this module's URL (Unix
// epoch milliseconds), then stands still until every `gate` path in the URL exists, and then
// runs on from where it stopped. A fixture creates its gate once it reaches the state the test
// needs, for example a test hung in its teardown. Until then the runner sees no time pass, so
// its lane deadline cannot arrive first. Only the runner process has this clock: it starts its
// test processes without the preload.
//
// Only Date.now and the global setTimeout and clearTimeout are held. node:timers/promises,
// setInterval, setImmediate, performance.now and new Date() keep real time, so durations and
// timestamps the runner records include the held time. While the clock is held, it says on
// stderr which gates are still missing every 10 s, so a fixture that never reaches its state
// shows up in the runner's output rather than only as the test's own timeout.
import { existsSync } from "node:fs";

const query = new URL(import.meta.url).searchParams;
const holdAt = Number(query.get("hold"));
const gates = query.getAll("gate");
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

// How long the clock stood still. Real time minus this is the runner's time.
let heldMs = 0;
let open = false;
// Timers due past the hold time, waiting for the gates.
const held = new Set();

function now() {
  const real = realNow() - heldMs;
  return open ? real : Math.min(real, holdAt);
}

class HeldTimer {
  constructor(callback, due, args) {
    this.callback = callback;
    this.due = due;
    this.args = args;
    this.refed = true;
    this.timer = undefined;
  }

  arm() {
    this.timer = realSetTimeout(() => this.callback(...this.args), Math.max(1, this.due - now()));
    if (!this.refed) {
      this.timer.unref();
    }
  }

  ref() {
    this.refed = true;
    this.timer?.ref();
    updatePoll();
    return this;
  }

  unref() {
    this.refed = false;
    this.timer?.unref();
    updatePoll();
    return this;
  }

  hasRef() {
    return this.refed;
  }
}

// Watches the gates while the clock may hold. It keeps the runner alive only while a held
// timer would have.
let nextReport = holdAt + 10_000;
const poll = setInterval(() => {
  const missing = gates.filter((gate) => !existsSync(gate));
  if (missing.length > 0) {
    if (realNow() >= nextReport) {
      nextReport += 10_000;
      process.stderr.write(
        `ci-runner-held-clock: still held; missing gates: ${missing.join(", ")}\n`,
      );
    }
    return;
  }
  heldMs = Math.max(0, realNow() - holdAt);
  open = true;
  clearInterval(poll);
  for (const timer of held) {
    timer.arm();
  }
  held.clear();
}, 10);
updatePoll();

function updatePoll() {
  if (open) {
    return;
  }
  if ([...held].some((timer) => timer.refed)) {
    poll.ref();
  } else {
    poll.unref();
  }
}

Date.now = now;

globalThis.setTimeout = function setTimeout(callback, delay, ...args) {
  if (typeof callback !== "function") {
    // Node's own setTimeout rejects it at once.
    return realSetTimeout(callback, delay, ...args);
  }
  // Node runs a timer whose delay is not a number from 1 to 2^31 - 1 after 1 ms.
  const ms = Number(delay);
  const due = now() + (ms >= 1 && ms <= 2 ** 31 - 1 ? ms : 1);
  if (open || due <= holdAt) {
    return realSetTimeout(callback, delay, ...args);
  }
  const timer = new HeldTimer(callback, due, args);
  held.add(timer);
  updatePoll();
  return timer;
};

globalThis.clearTimeout = function clearTimeout(timer) {
  if (timer instanceof HeldTimer) {
    held.delete(timer);
    if (timer.timer !== undefined) {
      realClearTimeout(timer.timer);
    }
    updatePoll();
    return;
  }
  realClearTimeout(timer);
};

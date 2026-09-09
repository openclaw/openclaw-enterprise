export function createViewLifetime() {
  let generation = 0;
  let reads = new AbortController();

  return {
    capture() {
      return generation;
    },
    isCurrent(active) {
      return active === generation;
    },
    get signal() {
      return reads.signal;
    },
    reset() {
      reads.abort();
      reads = new AbortController();
      generation += 1;
      return generation;
    },
  };
}

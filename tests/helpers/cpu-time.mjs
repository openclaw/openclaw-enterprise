/**
 * Milliseconds of CPU time a synchronous call costs, for budgets that guard against
 * super-linear work (for example a regex that backtracks on hostile input).
 *
 * Wall time also counts time spent waiting for a CPU: on a loaded runner or under a
 * CPU quota, a 10 ms call can take hundreds of milliseconds. CPU time does not. It counts
 * every thread in the process, so a garbage collection pause can still inflate a single
 * run; the cheapest of `runs` runs is returned, and the runs stop once one is under
 * `budgetMs`. Work that is really too slow is too slow on every run.
 */
export function cpuTimeMs(work, { budgetMs = Number.POSITIVE_INFINITY, runs = 3 } = {}) {
  let cheapest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs && cheapest >= budgetMs; run += 1) {
    const before = process.cpuUsage();
    work();
    const used = process.cpuUsage(before);
    cheapest = Math.min(cheapest, (used.user + used.system) / 1000);
  }
  return cheapest;
}

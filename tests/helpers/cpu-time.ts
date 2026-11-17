type CpuTimeOptions = {
  budgetMs?: number | undefined;
  runs?: number | undefined;
};

/**
 * Milliseconds of CPU time a synchronous call costs, for budgets that guard against
 * super-linear work (for example a regex that backtracks on hostile input).
 *
 * Wall time also counts time spent waiting for a CPU: on a loaded runner or under a
 * CPU quota, a 10 ms call can take hundreds of milliseconds. CPU time does not. It counts
 * every thread in the process, so a garbage collection pause can still inflate a single
 * run. When a budget is supplied, retry up to `runs` times and stop at the first
 * measurement under the budget. With the default infinite budget, measure once.
 */
export function cpuTimeMs(
  work: () => void,
  { budgetMs = Number.POSITIVE_INFINITY, runs = 3 }: CpuTimeOptions = {},
) {
  let cheapest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs && cheapest >= budgetMs; run += 1) {
    const before = process.cpuUsage();
    work();
    const used = process.cpuUsage(before);
    cheapest = Math.min(cheapest, (used.user + used.system) / 1000);
  }
  return cheapest;
}

/**
 * `cpuTimeMs` for asynchronous work, such as a page read through its awaited Driver
 * call. Only the awaited work may run in the process meanwhile: CPU time is not
 * attributed to a promise.
 */
export async function cpuTimeMsAsync(
  work: () => unknown,
  { budgetMs = Number.POSITIVE_INFINITY, runs = 3 }: CpuTimeOptions = {},
) {
  let cheapest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs && cheapest >= budgetMs; run += 1) {
    const before = process.cpuUsage();
    await work();
    const used = process.cpuUsage(before);
    cheapest = Math.min(cheapest, (used.user + used.system) / 1000);
  }
  return cheapest;
}

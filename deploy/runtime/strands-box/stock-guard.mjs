import { lstatSync, readFileSync, writeFileSync } from "node:fs";

// Check the running task on both sides of Box's namespace setup. A Pod
// declaration alone cannot detect a profile loaded in complain mode.
export function requireStockProfile() {
  const label = readFileSync("/proc/self/attr/current", "utf8").replace(/\0$/u, "").trim();
  const status = readFileSync("/proc/self/status", "utf8");
  if (
    label !== "oce-strands-box-v0.3.1 (enforce)" ||
    !/^NoNewPrivs:\s+1$/mu.test(status) ||
    !/^Seccomp:\s+2$/mu.test(status) ||
    !/^CapEff:\s+0+$/mu.test(status)
  ) {
    throw new Error("Stock Strands Box confinement is unavailable");
  }
}

// Container masks would prevent Box from mounting private procfs. Reapply
// them with Box deny mounts. Optional entries vary by node and kernel.
function procEntries() {
  const directories = ["asound", "acpi", "scsi"];
  const files = [
    "interrupts",
    "kcore",
    "keys",
    "latency_stats",
    "timer_list",
    "timer_stats",
    "sched_debug",
  ];
  const entries = [];
  for (const name of [...directories, ...files]) {
    const path = `/proc/${name}`;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!(directories.includes(name) ? stat.isDirectory() : stat.isFile())) {
      throw new Error("Unexpected stock Strands Box procfs entry");
    }
    entries.push({ path, stat });
  }
  return entries;
}

export function prepareStockConfig() {
  const config = readFileSync("/etc/strands-box/box.toml", "utf8");
  const sections = config.split("\n[agent.filesystem]\n");
  if (sections.length !== 2) throw new Error("Invalid stock Strands Box configuration");
  const paths = procEntries().map(({ path }) => path);
  const output = "/run/strands-box/stock.toml";
  // This mount is private to the launcher. Never reuse an earlier launch's file.
  writeFileSync(output, sections.join(`\n[agent.filesystem]\ndeny = ${JSON.stringify(paths)}\n`), {
    flag: "wx",
    mode: 0o400,
  });
  return output;
}

export function requireStockMasks() {
  const proc = lstatSync("/proc");
  if (
    !proc.isDirectory() ||
    procEntries().some(({ stat }) => stat.dev === proc.dev || (stat.isFile() && stat.size !== 0)) ||
    lstatSync("/sys/firmware", { throwIfNoEntry: false }) ||
    lstatSync("/sys/devices/virtual/powercap", { throwIfNoEntry: false })
  ) {
    throw new Error("Missing stock Strands Box kernel path masks");
  }
}

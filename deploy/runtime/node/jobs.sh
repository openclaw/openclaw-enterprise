#!/bin/sh
# Print the Make job count for the Node compile.
# Usage: jobs.sh REQUESTED CPUS MEMINFO CGROUP_DIR
# REQUESTED is a positive decimal integer, used as given, or auto. auto sizes
# the count to the builder running this step, so the build argument, and with
# it the layer cache key, stays the same on every builder.
set -eu

requested=$1
cpus=$2
meminfo=$3
cgroup=$4

case "$requested" in
  auto) ;;
  ""|0*|*[!0-9]*)
    echo "NODE_BUILD_JOBS must be auto or a positive decimal integer without leading zeros" >&2
    exit 1
    ;;
  *)
    echo "$requested"
    exit 0
    ;;
esac

case "$cpus" in
  ""|0*|*[!0-9]*) echo "jobs.sh: invalid CPU count: $cpus" >&2; exit 1 ;;
esac

# A cgroup CPU quota ("quota period") lowers the usable CPU count.
if [ -r "$cgroup/cpu.max" ] && read -r quota period <"$cgroup/cpu.max" && [ "$quota" != max ]; then
  quota_cpus=$((quota / period))
  [ "$quota_cpus" -ge 1 ] || quota_cpus=1
  [ "$quota_cpus" -ge "$cpus" ] || cpus=$quota_cpus
fi

available_kib=$(awk '$1 == "MemAvailable:" { print $2 }' "$meminfo")
case "$available_kib" in
  ""|*[!0-9]*) echo "jobs.sh: no MemAvailable in $meminfo" >&2; exit 1 ;;
esac
# A cgroup memory limit lowers what the compile can use.
if [ -r "$cgroup/memory.max" ] && read -r limit <"$cgroup/memory.max" && [ "$limit" != max ]; then
  used=0
  if [ -r "$cgroup/memory.current" ]; then read -r used <"$cgroup/memory.current"; fi
  cgroup_kib=$(((limit - used) / 1024))
  [ "$cgroup_kib" -ge "$available_kib" ] || available_kib=$cgroup_kib
fi

# Leave 8 GiB for the image's other build stages, which run beside this one,
# and budget 2 GiB per compiler job: the step's cgroup peaked at about 1 GiB
# per job at 32 and 64 jobs, page cache included. The cap bounds the load on
# large shared hosts; the serial code generation, link and tests remain.
by_memory=$(((available_kib / 1048576 - 8) / 2))
jobs=$cpus
[ "$by_memory" -ge "$jobs" ] || jobs=$by_memory
[ "$jobs" -le 64 ] || jobs=64
# Never fewer than the previous fixed default of four.
[ "$jobs" -ge 4 ] || jobs=4
echo "NODE_BUILD_JOBS=auto selected $jobs compiler jobs (CPUs: $cpus, available memory: $((available_kib / 1048576)) GiB)" >&2
echo "$jobs"

#!/usr/bin/env bash
# Records runner memory while a CI lane runs, to diagnose hosted-runner loss.
# Usage: memory-sampler.sh <output-file> [interval-seconds]
#
# About every interval it appends one sample (meminfo, memory pressure, load,
# root disk space, the largest processes by RSS, and container memory) to
# <output-file>. Every fourth sample it also prints one summary line, so the job log keeps a
# memory curve even when the runner is lost before any later step can run.
# Processes are listed by executable name only (never arguments or
# environment), and nothing here may fail the lane.
set -u

output=${1:?output file required}
interval=${2:-15}
max_bytes=$((1024 * 1024))

mkdir -p "$(dirname "$output")" 2>/dev/null || true

meminfo_mib() {
  awk -v key="$1:" '$1 == key { printf "%d", $2 / 1024; found = 1 } END { if (!found) printf "?" }' /proc/meminfo 2>/dev/null
}

pressure() {
  # "some avg10=… full avg10=…" from PSI, when the kernel exposes it.
  awk '{ printf "%s %s ", $1, $2 }' /proc/pressure/memory 2>/dev/null
}

top_rss() {
  # comm is the executable name (at most 15 bytes); args may hold secrets.
  ps -eo rss=,comm= --sort=-rss 2>/dev/null | head -n "$1"
}

# Stop promptly, with no stray sleep left holding the job log open.
trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM INT

sample=0
while true; do
  sample=$((sample + 1))
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  available=$(meminfo_mib MemAvailable)
  swap_total=$(meminfo_mib SwapTotal)
  swap_free=$(meminfo_mib SwapFree)
  swap_used='?'
  if [[ $swap_total =~ ^[0-9]+$ && $swap_free =~ ^[0-9]+$ ]]; then
    swap_used=$((swap_total - swap_free))
  fi
  psi=$(pressure)
  disk=$(df -BM --output=avail / 2>/dev/null | tail -n 1 | tr -d ' ')
  size=$(stat -c %s "$output" 2>/dev/null || echo 0)
  if ((size < max_bytes)); then
    {
      echo "=== sample $sample $now"
      echo "mem_mib total=$(meminfo_mib MemTotal) available=$available free=$(meminfo_mib MemFree) cached=$(meminfo_mib Cached) swap_used=$swap_used"
      echo "psi_memory ${psi:-unavailable}"
      echo "loadavg $(cut -d ' ' -f 1-3 /proc/loadavg 2>/dev/null)"
      echo "disk_root_available ${disk:-?}"
      echo "top_rss_kib comm"
      top_rss 10
      echo "containers name mem_usage mem_percent"
      timeout 10 docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}' 2>/dev/null | head -n 10
    } >>"$output" 2>/dev/null
  fi
  if ((sample % 4 == 1)); then
    top=$(top_rss 3 | awk '{ printf "%s%s:%dMiB", sep, $2, $1 / 1024; sep = "," }')
    echo "memory-sampler $now available=${available}MiB swap_used=${swap_used}MiB disk_available=${disk:-?} ${psi}top=${top}"
  fi
  sleep "$interval" &
  wait $!
done

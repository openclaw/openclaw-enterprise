#!/usr/bin/env bash
# Download one pinned file and verify its SHA-256.
#
# Usage: download-pinned.sh <url> <destination> <sha256> [cache-directory] [existing-file] [mode]
#
# Every CI tool download goes through this script so transient network
# failures are retried the same way everywhere. A transient failure is a
# connection, TLS, timeout or truncated-transfer error, or HTTP 408, 429 or
# 5xx. Other failures (HTTP 404, a bad URL, a write error) fail on the first
# attempt. Retries back off 2, 4, 8, 16, then 20 seconds, and stop after
# eight attempts, or when the next retry would start more than 120 seconds
# after the last attempt that received bytes (or the first attempt, before
# any did). GitHub release assets have answered 503 for over 30 seconds while
# other requests succeeded, so retries continue for about 90 seconds rather
# than ending at 30.
# Each attempt may take up to 300 seconds (curl --max-time). A retry resumes
# from the bytes already received (curl --continue-at), so an attempt that
# was cut off while it still moved data does not start over. dl.k8s.io has
# served kubectl (about 59 MB) at about 140 KB/s, which needs more than one
# 300 second attempt. No attempt starts or runs past 600 seconds after the
# first one began, so a download gives up within about ten minutes.
# An attempt that moves less than 100 KiB/s for 30 seconds is cut off as a
# stall (curl exit 28) and retried like any other timeout. Healthy runner
# downloads move tens of MB/s, so this only ends an attempt that has all but
# stopped. DOWNLOAD_PINNED_SPEED_LIMIT (bytes/s), DOWNLOAD_PINNED_SPEED_TIME,
# DOWNLOAD_PINNED_MAX_TIME and DOWNLOAD_PINNED_RETRY_BUDGET (seconds) override
# these limits for tests.
# If a server ignores the resume request (curl exit 33 or HTTP 416), the
# received bytes are discarded and the next attempt starts over.
# The checksum is checked once, on the final file, and a mismatch is never
# retried.
set -euo pipefail

if [[ $# -lt 3 || $# -gt 6 ]]; then
  echo "Usage: $0 <url> <destination> <sha256> [cache-directory] [existing-file] [mode]" >&2
  exit 64
fi

url="$1"
destination="$2"
expected_sha256="$3"
cache_directory="${4:-}"
existing_file="${5:-}"
requested_mode="${6:-}"
if [[ -n "${requested_mode}" && ! "${requested_mode}" =~ ^0?[0-7]{3}$ ]]; then
  echo "Expected an ordinary octal permission mode." >&2
  exit 64
fi
if [[ ! "${expected_sha256}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Expected a lowercase SHA-256 digest." >&2
  exit 64
fi
max_attempts=8
max_delay_seconds=20
retry_budget_seconds="${DOWNLOAD_PINNED_RETRY_BUDGET:-120}"
deadline_seconds=600
attempt_max_seconds="${DOWNLOAD_PINNED_MAX_TIME:-300}"
speed_limit_bytes="${DOWNLOAD_PINNED_SPEED_LIMIT:-102400}"
speed_time_seconds="${DOWNLOAD_PINNED_SPEED_TIME:-30}"

verify_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${expected_sha256}  ${temporary}" | sha256sum -c -
  else
    echo "${expected_sha256}  ${temporary}" | shasum -a 256 -c -
  fi
}

# Cache bytes are never executed or published directly. A private copy must pass
# the caller's repository checksum, even when Actions reports an exact cache hit.
copy_verified() {
  [[ -f "$1" ]] || return 1
  cp "$1" "${temporary}" && verify_checksum
}

restore_cache() {
  [[ -n "${cache_directory}" ]] || return 1
  local cached="${cache_directory}/${expected_sha256}"
  [[ -f "${cached}" && ! -L "${cached}" ]] || return 1
  copy_verified "${cached}"
}

save_cache() (
  [[ -n "${cache_directory}" ]] || exit 0
  mkdir -p "${cache_directory}" || exit 1
  [[ ! -d "${cache_directory}/${expected_sha256}" ]] || exit 1
  local cached
  cached="$(mktemp "${cache_directory}/.verified.XXXXXX")" || exit 1
  trap 'rm -f "${cached}"' EXIT
  cp "${temporary}" "${cached}" && chmod 0644 "${cached}" &&
    mv -f "${cached}" "${cache_directory}/${expected_sha256}"
)

is_transient() {
  local status="$1"
  local http_code="$2"
  case "${status}" in
    22) [[ "${http_code}" =~ ^(408|429|5[0-9][0-9])$ ]] ;;
    # proxy/DNS/connect failure, partial file, timeout, HTTP/2 framing, TLS
    # handshake, empty reply, send/receive failure, HTTP/2 stream error
    5 | 6 | 7 | 16 | 18 | 28 | 35 | 52 | 55 | 56 | 92) return 0 ;;
    *) return 1 ;;
  esac
}

received_bytes() {
  wc -c <"${temporary}" | tr -d ' '
}

# Publish only bytes that passed the pinned checksum. Keep the temporary file
# beside the destination so the final rename stays on the same filesystem.
if [[ -d "${destination}" ]]; then
  echo "Download destination is a directory: ${destination}" >&2
  exit 1
fi
temporary="$(mktemp "${destination}.download.XXXXXX")"
trap 'rm -f "${temporary}"' EXIT
# Keep all candidate copies private and writable, including replacement of a
# read-only tool. Apply the previous mode without setuid/setgid only after verification.
chmod 0600 "${temporary}"
if [[ -n "${requested_mode}" ]]; then
  publication_mode="${requested_mode}"
elif [[ -f "${destination}" ]]; then
  publication_mode="$(stat -L -c '%a' "${destination}" 2>/dev/null || stat -L -f '%Lp' "${destination}")"
  publication_mode="$(printf '%o' "$((8#${publication_mode} & 01777))")"
else
  publication_mode="$(printf '%o' "$((0666 & ~$(umask)))")"
fi

cache_hit=false
if [[ -n "${existing_file}" ]] && copy_verified "${existing_file}" >/dev/null 2>&1; then
  : # An installed file passed the same checksum as a fresh download.
elif restore_cache >/dev/null 2>&1; then
  cache_hit=true
else
  # Discard even a partial or corrupt cache copy before the ordinary downloader.
  : >"${temporary}"
  if ! command -v curl >/dev/null 2>&1; then
    echo "Missing required command: curl" >&2
    exit 1
  fi
  attempt=1
  delay=2
  started=${SECONDS}
  progress_at=${started}
  while :; do
    status=0
    attempt_started=${SECONDS}
    before=$(received_bytes)
    resume=()
    if [[ ${before} -gt 0 ]]; then
      resume=(--continue-at -)
    fi
    max_time=$((started + deadline_seconds - SECONDS))
    if [[ ${max_time} -gt ${attempt_max_seconds} ]]; then
      max_time=${attempt_max_seconds}
    elif [[ ${max_time} -lt 1 ]]; then
      max_time=1
    fi
    transfer="$(curl --fail --silent --show-error --location \
      --connect-timeout 20 --max-time "${max_time}" \
      --speed-limit "${speed_limit_bytes}" --speed-time "${speed_time_seconds}" \
      ${resume[@]+"${resume[@]}"} \
      --write-out '%{http_code} %{speed_download}' --output "${temporary}" "${url}")" || status=$?
    http_code="${transfer%% *}"
    after=$(received_bytes)
    # curl --silent hides progress, so name slow attempts for the next stall investigation.
    if [[ $((SECONDS - attempt_started)) -ge 20 ]]; then
      echo "Slow download attempt ${attempt}: $((SECONDS - attempt_started))s, average ${transfer#* } bytes/s, ${after} bytes received, curl exit ${status}: ${url}" >&2
    fi
    if [[ ${status} -eq 0 ]]; then
      break
    fi
    transient=false
    if [[ ${#resume[@]} -gt 0 ]] && { [[ ${status} -eq 33 ]] || [[ ${status} -eq 22 && "${http_code}" == "416" ]]; }; then
      echo "Server refused to resume at byte ${before}; starting over: ${url}" >&2
      : >"${temporary}"
      transient=true
    elif is_transient "${status}" "${http_code}"; then
      transient=true
      if [[ ${after} -gt ${before} ]]; then
        progress_at=${SECONDS}
      fi
    fi
    if [[ ${transient} != true ]] ||
      [[ ${attempt} -ge ${max_attempts} ]] ||
      [[ $((SECONDS - progress_at + delay)) -gt ${retry_budget_seconds} ]] ||
      [[ $((SECONDS - started + delay)) -ge ${deadline_seconds} ]]; then
      echo "Download failed (curl exit ${status}, HTTP ${http_code:-none}) after ${attempt} attempt(s): ${url}" >&2
      exit "${status}"
    fi
    resuming=""
    if [[ $(received_bytes) -gt 0 ]]; then
      resuming=", resuming at byte $(received_bytes)"
    fi
    echo "Transient download failure (curl exit ${status}, HTTP ${http_code:-none}); retrying in ${delay}s (attempt $((attempt + 1))/${max_attempts}${resuming}): ${url}" >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
    delay=$((delay * 2 > max_delay_seconds ? max_delay_seconds : delay * 2))
  done

  verify_checksum
fi

# A cache is optional transport, not a prerequisite for a verified download.
if [[ "${cache_hit}" != true ]] && ! save_cache; then
  echo "Tool cache unavailable; continuing with verified download." >&2
fi

# Publication retains the previous destination mode, or the caller's umask for
# a new destination. Neither mode applies to unverified staging bytes.
chmod "${publication_mode}" "${temporary}"
mv -f "${temporary}" "${destination}"

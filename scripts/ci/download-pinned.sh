#!/usr/bin/env bash
# Download one pinned file and verify its SHA-256.
#
# Usage: download-pinned.sh <url> <destination> <sha256>
#
# Every CI tool download goes through this script so transient network
# failures are retried the same way everywhere. A transient failure is a
# connection, TLS, timeout or truncated-transfer error, or HTTP 408, 429 or
# 5xx. Other failures (HTTP 404, a bad URL, a write error) fail on the first
# attempt. Retries back off 2, 4, 8, 16, then 20 seconds, and stop after
# eight attempts, or when the next retry would start more than 120 seconds
# after the first attempt began (elapsed time plus the backoff delay). GitHub
# release assets have answered 503 for over 30 seconds while other requests
# succeeded, so retries continue for about 90 seconds rather than ending at 30.
# The budget does not cut a running attempt short:
# each attempt may take up to 300 seconds (curl --max-time), so a download
# gives up within about seven minutes. A late HTTPS timeout with a private
# prefix may use one final range continuation within that same envelope;
# it must succeed with HTTP 206 and pass the full pinned checksum.
# An attempt that moves less than 100 KiB/s for 30 seconds is cut off as a
# stall (curl exit 28) and retried like any other timeout. Healthy runner
# downloads move tens of MB/s, and the 300 second cap already needs about
# 195 KB/s for the largest pinned file (kubectl, about 59 MB), so this only
# ends an attempt that has all but stopped. DOWNLOAD_PINNED_SPEED_LIMIT
# (bytes/s) and DOWNLOAD_PINNED_SPEED_TIME (seconds) override the threshold
# for tests.
# The checksum is checked once, on the final file, and a mismatch is never
# retried.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <url> <destination> <sha256>" >&2
  exit 64
fi

url="$1"
destination="$2"
expected_sha256="$3"
max_attempts=8
max_delay_seconds=20
retry_budget_seconds=120
speed_limit_bytes="${DOWNLOAD_PINNED_SPEED_LIMIT:-102400}"
speed_time_seconds="${DOWNLOAD_PINNED_SPEED_TIME:-30}"

if ! command -v curl >/dev/null 2>&1; then
  echo "Missing required command: curl" >&2
  exit 1
fi

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

# Publish only bytes that passed the pinned checksum. Keep the temporary file
# beside the destination so the final rename stays on the same filesystem.
if [[ -d "${destination}" ]]; then
  echo "Download destination is a directory: ${destination}" >&2
  exit 1
fi
temporary="$(mktemp "${destination}.download.XXXXXX")"
trap 'rm -f "${temporary}"' EXIT
# curl preserves the mode when replacing an existing file. Seed the temporary
# file the same way so successful publication retains that behavior.
if [[ -f "${destination}" ]]; then
  cp -p "${destination}" "${temporary}"
else
  new_file_mode="$(printf '%o' "$((0666 & ~$(umask)))")"
fi

attempt=1
delay=2
started=${SECONDS}
while :; do
  # Never resume bytes from the installed file or an older attempt.
  : > "${temporary}"
  status=0
  attempt_started=${SECONDS}
  transfer="$(curl --fail --silent --show-error --location \
    --connect-timeout 20 --max-time 300 \
    --speed-limit "${speed_limit_bytes}" --speed-time "${speed_time_seconds}" \
    --write-out '%{http_code} %{speed_download} %{url_effective}' --output "${temporary}" "${url}")" || status=$?
  read -r http_code average_speed effective_url <<< "${transfer}"
  # curl --silent hides progress, so name slow attempts for the next stall investigation.
  if [[ $((SECONDS - attempt_started)) -ge 20 ]]; then
    echo "Slow download attempt ${attempt}: $((SECONDS - attempt_started))s, average ${average_speed} bytes/s, curl exit ${status}: ${url}" >&2
  fi
  if [[ ${status} -eq 0 ]]; then
    break
  fi
  # Require HTTP 206 and the full pinned checksum before publishing. curl can
  # exit zero for a wrong range start or HTTP 416; the status check and checksum
  # reject incomplete or changed representations even when curl exits zero.
  remaining=$((420 - (SECONDS - started)))
  if [[ ${status} -eq 28 && ${http_code} == 200 &&
    ${url} == https://* && ${effective_url} == https://* && -s ${temporary} &&
    $((SECONDS - attempt_started)) -ge 120 &&
    $((SECONDS - started + delay)) -gt ${retry_budget_seconds} &&
    ${attempt} -lt ${max_attempts} && ${remaining} -gt 0 ]]; then
    attempt=$((attempt + 1))
    remaining=$((remaining > 120 ? 120 : remaining))
    echo "Resuming timed-out download once (attempt ${attempt}/${max_attempts}, at most ${remaining}s): ${url}" >&2
    status=0
    transfer="$(curl --fail --silent --show-error --location \
      --proto '=https' --proto-redir '=https' \
      --connect-timeout 20 --max-time "${remaining}" --continue-at - \
      --speed-limit "${speed_limit_bytes}" --speed-time "${speed_time_seconds}" \
      --write-out '%{http_code} %{speed_download}' --output "${temporary}" "${url}")" || status=$?
    http_code="${transfer%% *}"
    if [[ ${status} -eq 0 && ${http_code} == 206 ]]; then
      break
    fi
    # This is terminal, even if curl reports a transient failure again.
    echo "Download continuation failed (curl exit ${status}, HTTP ${http_code:-none}): ${url}" >&2
    exit "$((status == 0 ? 1 : status))"
  fi
  if ! is_transient "${status}" "${http_code}" ||
    [[ ${attempt} -ge ${max_attempts} ]] ||
    [[ $((SECONDS - started + delay)) -gt ${retry_budget_seconds} ]]; then
    echo "Download failed (curl exit ${status}, HTTP ${http_code:-none}) after ${attempt} attempt(s): ${url}" >&2
    exit "${status}"
  fi
  echo "Transient download failure (curl exit ${status}, HTTP ${http_code:-none}); retrying in ${delay}s (attempt $((attempt + 1))/${max_attempts}): ${url}" >&2
  sleep "${delay}"
  attempt=$((attempt + 1))
  delay=$((delay * 2 > max_delay_seconds ? max_delay_seconds : delay * 2))
done

if command -v sha256sum >/dev/null 2>&1; then
  echo "${expected_sha256}  ${temporary}" | sha256sum -c -
else
  echo "${expected_sha256}  ${temporary}" | shasum -a 256 -c -
fi

# Keep a first download private until verification has succeeded, then publish
# it with the same umask-derived permissions curl would have created.
if [[ -n "${new_file_mode:-}" ]]; then
  chmod "${new_file_mode}" "${temporary}"
fi
mv -f "${temporary}" "${destination}"

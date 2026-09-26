#!/usr/bin/env python3
"""Drive an interactive OpenClaw TUI command through a pseudoterminal."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from typing import Sequence


ANSI_RE = re.compile(
    rb"""
    \x1b
    (?:
      \[[0-?]*[ -/]*[@-~]
      |\][^\x07]*(?:\x07|\x1b\\)
      |[@-Z\\-_]
    )
    """,
    re.VERBOSE,
)
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]")
LINE_DECORATION = " \t|│┃║┆┇┊┋┌┐└┘┬┴├┤┼─━═╭╮╰╯"


def visible_text(chunks: Sequence[bytes]) -> str:
    text = ANSI_RE.sub(b"", b"".join(chunks)).decode("utf-8", "replace")
    text = text.replace("\r", "\n")
    while "\b" in text:
        text = re.sub(r"[^\n]\x08", "", text)
        text = text.replace("\b", "")
    return CONTROL_RE.sub("", text)


def compact(value: str) -> str:
    return " ".join(value.split())


def rendered_payload(line: str) -> str:
    payload = compact(line).strip(LINE_DECORATION)
    payload = re.sub(r"^(?:assistant|openclaw|ai)\s*[:>]\s*", "", payload, flags=re.IGNORECASE)
    return payload.strip(LINE_DECORATION)


def transcript_tail(chunks: Sequence[bytes], limit: int = 4000) -> str:
    text = visible_text(chunks)
    return text[-limit:]


def assistant_reply_line(chunks: Sequence[bytes], nonce: str, prompt: str) -> str | None:
    compact_prompt = compact(prompt)
    for line in visible_text(chunks).splitlines():
        compact_line = compact(line)
        if compact_prompt not in compact_line and rendered_payload(line) == nonce:
            return compact_line
    return None


class PtyCommand:
    def __init__(self, command: Sequence[str], rows: int = 40, cols: int = 220) -> None:
        master_fd, slave_fd = os.openpty()
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.master_fd = master_fd
        self.process = subprocess.Popen(
            command,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            start_new_session=True,
        )
        os.close(slave_fd)
        os.set_blocking(self.master_fd, False)
        self.chunks: list[bytes] = []

    def read_available(self, timeout: float = 0.05) -> None:
        while True:
            readable, _, _ = select.select([self.master_fd], [], [], timeout)
            if not readable:
                return
            timeout = 0
            try:
                chunk = os.read(self.master_fd, 8192)
            except BlockingIOError:
                return
            except OSError:
                return
            if not chunk:
                return
            self.chunks.append(chunk)

    def write(self, value: str) -> None:
        os.write(self.master_fd, value.encode("utf-8"))

    def send_ctrl_d(self) -> None:
        os.write(self.master_fd, b"\x04")

    def poll(self) -> int | None:
        self.read_available(0)
        return self.process.poll()

    def wait_for_reply(self, nonce: str, prompt: str, timeout: float) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read_available()
            line = assistant_reply_line(self.chunks, nonce, prompt)
            if line is not None:
                if self.process.poll() is not None:
                    raise RuntimeError(
                        f"TUI exited after rendering {nonce}.\n{transcript_tail(self.chunks)}"
                    )
                return line
            if self.process.poll() is not None:
                break
            time.sleep(0.05)
        raise TimeoutError(f"Timed out waiting for assistant reply {nonce}.\n{transcript_tail(self.chunks)}")

    def wait_for_pattern(self, pattern: re.Pattern[str], timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read_available()
            if pattern.search(visible_text(self.chunks)):
                return True
            if self.process.poll() is not None:
                return bool(pattern.search(visible_text(self.chunks)))
            time.sleep(0.05)
        return False

    def wait_for_exit(self, timeout: float) -> int | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read_available()
            code = self.process.poll()
            if code is not None:
                self.read_available(0)
                return code
            time.sleep(0.05)
        return None

    def terminate(self) -> None:
        self.read_available(0)
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if self.wait_for_exit(3) is None:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.wait_for_exit(3)
        os.close(self.master_fd)


def require_command(raw: Sequence[str]) -> list[str]:
    if not raw:
        raise SystemExit("missing command after --")
    return list(raw)


def emit(value: object) -> None:
    print(json.dumps(value, sort_keys=True))


def run_conversation(args: argparse.Namespace) -> int:
    command = PtyCommand(require_command(args.command))
    try:
        connected = command.wait_for_pattern(re.compile(args.connected_pattern, re.IGNORECASE), 60)
        if not connected:
            raise TimeoutError(f"Timed out waiting for TUI connected state.\n{transcript_tail(command.chunks)}")
        first_line = command.wait_for_reply(args.first_nonce, args.first_prompt, args.timeout)
        command.write(f"{args.second_prompt}\r")
        second_line = command.wait_for_reply(args.second_nonce, args.second_prompt, args.timeout)
        command.send_ctrl_d()
        exit_code = command.wait_for_exit(args.exit_timeout)
        if exit_code is None:
            raise TimeoutError(f"TUI did not exit after Ctrl+D.\n{transcript_tail(command.chunks)}")
        emit(
            {
                "exitCode": exit_code,
                "firstReplyLine": first_line,
                "secondReplyLine": second_line,
                "transcriptTail": transcript_tail(command.chunks),
            }
        )
        return 0 if exit_code == 0 else exit_code
    except Exception as error:
        command.terminate()
        emit({"error": str(error), "transcriptTail": transcript_tail(command.chunks)})
        return 1
    finally:
        if command.process.poll() is None:
            command.terminate()


def run_expect_failure(args: argparse.Namespace) -> int:
    command = PtyCommand(require_command(args.command))
    denial = re.compile(args.deny_pattern, re.IGNORECASE)
    try:
        denied = command.wait_for_pattern(denial, args.timeout)
        reply = assistant_reply_line(command.chunks, args.nonce, args.prompt)
        if reply is not None:
            raise RuntimeError(f"denied TUI rendered an assistant reply: {reply}")
        if not denied:
            raise TimeoutError(
                f"Timed out waiting for authentication denial.\n{transcript_tail(command.chunks)}"
            )
        if command.process.poll() is None:
            command.send_ctrl_d()
            command.wait_for_exit(args.exit_timeout)
        emit({"denied": True, "transcriptTail": transcript_tail(command.chunks)})
        return 0
    except Exception as error:
        command.terminate()
        emit({"error": str(error), "transcriptTail": transcript_tail(command.chunks)})
        return 1
    finally:
        if command.process.poll() is None:
            command.terminate()


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subparsers = root.add_subparsers(dest="mode", required=True)

    conversation = subparsers.add_parser("conversation")
    conversation.add_argument("--first-nonce", required=True)
    conversation.add_argument("--first-prompt", required=True)
    conversation.add_argument("--second-nonce", required=True)
    conversation.add_argument("--second-prompt", required=True)
    conversation.add_argument(
        "--connected-pattern",
        default=r"\bconnected\b|\bready\b|\bauthenticated\b|\bpaired\b",
    )
    conversation.add_argument("--timeout", type=float, default=240)
    conversation.add_argument("--exit-timeout", type=float, default=15)
    conversation.add_argument("command", nargs=argparse.REMAINDER)
    conversation.set_defaults(func=run_conversation)

    expect_failure = subparsers.add_parser("expect-failure")
    expect_failure.add_argument("--nonce", required=True)
    expect_failure.add_argument("--prompt", required=True)
    expect_failure.add_argument(
        "--deny-pattern",
        default=r"token[_ -]?mismatch|unauthori[sz]ed[^.\n]{0,120}token|token[^.\n]{0,120}unauthori[sz]ed",
    )
    expect_failure.add_argument("--timeout", type=float, default=60)
    expect_failure.add_argument("--exit-timeout", type=float, default=15)
    expect_failure.add_argument("command", nargs=argparse.REMAINDER)
    expect_failure.set_defaults(func=run_expect_failure)

    return root


def main() -> int:
    args = parser().parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

"""One Linux CLOCK_REALTIME timerfd detects clock steps even between samples."""
import ctypes
import os
import sys
import time

libc = ctypes.CDLL(None, use_errno=True)
class Timespec(ctypes.Structure):
    _fields_ = [("sec", ctypes.c_long), ("nsec", ctypes.c_long)]
class Timer(ctypes.Structure):
    _fields_ = [("interval", Timespec), ("value", Timespec)]

fd = libc.timerfd_create(0, os.O_NONBLOCK | os.O_CLOEXEC)
if fd < 0 or libc.timerfd_settime(fd, 3, ctypes.byref(Timer(
        Timespec(), Timespec(int(time.time()) + 86400, 0))), None) != 0:
    raise RuntimeError("clock-step monitor unavailable")
for line in sys.stdin:
    if line != "sample\n":
        sys.exit(2)
    try:
        os.read(fd, 8)
    except BlockingIOError:
        print(time.time_ns() // 1_000_000, flush=True)
    else:
        sys.exit(3)

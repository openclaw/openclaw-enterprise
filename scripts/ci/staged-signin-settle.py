#!/usr/bin/env python3
"""Run the prepared sign-in case once; report process settlement independently."""
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

COMMAND = ['node', 'scripts/ci/run-tests.mjs', 'prepared-signin']


def write_json(fd, value):
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    if len(sys.argv) != 1 or sys.platform != 'linux':
        raise ValueError('expected a no-argument Linux invocation')
    bindings = {}
    for name in ('OCC_TEST_SIGNIN_PLAN_SHA256', 'OCC_TEST_SIGNIN_PREPARED_SHA256',
                 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        value = os.environ.get(name, '')
        pattern = '[a-f0-9]{64}' if name.endswith('SHA256') else '[1-9][0-9]*'
        if not re.fullmatch(pattern, value):
            raise ValueError('missing or invalid binding: ' + name)
        bindings[name] = value
    temporary = Path(os.environ.get('RUNNER_TEMP', ''))
    if not temporary.is_absolute() or not temporary.is_dir():
        raise ValueError('RUNNER_TEMP must name an existing absolute directory')
    directory = temporary / 'staging-installed-signin'
    directory.mkdir(mode=0o700, exist_ok=True)
    receipt = directory / 'case-returned.json'
    value = {'version': 1, 'bindings': bindings, 'completed': False}
    reserved = os.open(receipt, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    write_json(reserved, value)

    # This one-shot process has no other children; adopted orphans belong to this run.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError('cannot enable Linux child subreaper')
    log = os.open(directory / 'case.log', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(log, 'wb') as output:
        sync_directory(directory)
        child = subprocess.Popen(COMMAND, stdin=subprocess.DEVNULL, stdout=output,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        code = child.wait()
    reaped = 0
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            quiescent = True
            break
        if pid == 0:
            quiescent = False
            break
        reaped += 1
    value.update(completed=True, returnCode=code,
                 exitCode=code if code >= 0 else None,
                 signal=-code if code < 0 else None,
                 descendantsQuiescent=quiescent, reapedDescendants=reaped)
    fd, pending = tempfile.mkstemp(prefix='.case-returned-', dir=directory)
    try:
        write_json(fd, value)
        os.replace(pending, receipt)
        sync_directory(directory)
    finally:
        Path(pending).unlink(missing_ok=True)
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        # Incomplete or absent receipt is deliberately ambiguous: the caller must hold cleanup.
        print('Sign-in child settlement failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)

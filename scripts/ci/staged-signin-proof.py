#!/usr/bin/env python3
"""Validate complete selected sign-in observations without emitting proof rows."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import sys


def finite_number(value):
    return type(value) in (int, float) and (type(value) is int or math.isfinite(value))


def required_observations(previous_version, live_return):
    # This is the artifact contract of runTransition, not proof that it executed.
    def issued(ordinal, target):
        return ('issued', ordinal, target)

    def result(ordinal, expected, timing='live'):
        return ('result', ordinal, expected, timing, 200 if expected == 'allowed' else 401)

    handoff = ('handoff',)
    admission = ('admission-refusal',)
    fence = ('legacy-fence-complete',)
    replacement = ('replacement',)
    complete = ('complete',)
    if previous_version == 3:
        return [
            [issued(1, 'P'), result(1, 'allowed'), issued(2, 'P'), handoff, admission, replacement,
             result(1, 'deny'), result(2, 'allowed'), result(2, 'deny'), complete],
            [issued(3, 'A'), result(3, 'allowed'), issued(4, 'A'), handoff, replacement,
             result(3, 'deny'), result(4, 'allowed'), result(4, 'deny'), result(2, 'deny'),
             issued(5, 'P'), result(5, 'deny', 'expired'),
             issued(6, 'P'), result(6, 'allowed'), complete],
        ]
    returned = ([result(10, 'allowed'), result(10, 'deny', 'observed')] if live_return
                else [result(10, 'deny', 'expired')])
    return [
        [issued(1, 'P'), result(1, 'allowed'), issued(2, 'P'), handoff, admission, fence, replacement,
         result(1, 'deny', 'observed'), result(2, 'deny', 'observed'), complete],
        [issued(3, 'P'), result(3, 'allowed'), issued(4, 'P'), handoff, replacement,
         result(3, 'deny'), result(4, 'deny'), complete],
        [issued(5, 'A'), result(5, 'allowed'), issued(6, 'A'), handoff, replacement,
         result(5, 'deny'), result(6, 'allowed'), result(6, 'deny'),
         issued(7, 'A'), result(7, 'deny', 'expired'), complete],
        [issued(8, 'A'), result(8, 'allowed'), issued(9, 'A'), result(9, 'allowed'),
         issued(10, 'A'), handoff, fence, replacement, result(9, 'deny'), result(10, 'deny'), complete],
        [issued(11, 'P'), result(11, 'allowed'), issued(12, 'P'), handoff, replacement,
         result(12, 'deny'), result(9, 'deny', 'observed'), *returned,
         issued(13, 'A'), result(13, 'allowed'), complete],
    ]


def read_proof(path, previous_version, candidate_version, expected_cluster):
    if (type(previous_version) is not int or type(candidate_version) is not int
            or (previous_version, candidate_version) not in ((2, 3), (3, 3))):
        raise ValueError('unsupported sign-in protocol')
    stages = (['P-to-P', 'P-to-A', 'A-to-A', 'A-to-P', 'P-back-to-A']
              if previous_version == 2 else ['P-to-A', 'A-to-P'])
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        limit = 4 * 1024 * 1024
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise ValueError('proof must be a bounded regular file')
        raw = os.read(descriptor, limit + 1)
        if len(raw) != info.st_size:
            raise ValueError('proof size changed during read')
    finally:
        os.close(descriptor)
    proof = json.loads(raw)
    if (not isinstance(proof, dict) or proof.get('source') != 'production Helm'
            or not isinstance(expected_cluster, str) or not expected_cluster
            or proof.get('cluster') != expected_cluster):
        raise ValueError('proof source or cluster differs')
    rows = proof.get('rows')
    if not isinstance(rows, list):
        raise ValueError('proof rows must be an array')
    observations = []
    issued_count = 0
    remaining_by_ordinal = {}

    def observe_remaining(ordinal, remaining):
        # A receipt has one fixed deadline, and the producer's clock never retreats.
        previous = remaining_by_ordinal.get(ordinal)
        if previous is not None and remaining > previous:
            raise ValueError('receipt remaining time increased')
        remaining_by_ordinal[ordinal] = remaining

    for row in rows:
        if not isinstance(row, dict) or row.get('disposition', 'PASS') != 'PASS':
            raise ValueError('proof contains a non-passing row')
        replacement = row.get('decision') == 'replacement-verified'
        complete = row.get('event') == 'transition-complete'
        fence = row.get('decision') == 'legacy-fence-complete'
        event = row.get('event')
        if (replacement or fence) and event in ('issued', 'result', 'transition-complete',
                                                'handoff', 'admission-refusal'):
            raise ValueError('observations require separate rows')
        if event in ('issued', 'result'):
            remaining = row.get('remainingMs')
            if (type(row.get('ordinal')) is not int
                    or not finite_number(remaining)):
                raise ValueError('invalid receipt observation')
            observe_remaining(row['ordinal'], remaining)
            if event == 'issued':
                if remaining <= 0:
                    raise ValueError('receipt was not live at issuance')
                issued_count += 1
                observation = ('issued', row['ordinal'], row.get('target'))
            else:
                timing = row.get('timing')
                if ((timing == 'live' and remaining <= 0)
                        or (timing == 'expired' and remaining > 0)
                        or type(row.get('status')) is not int):
                    raise ValueError('invalid result observation')
                observation = ('result', row['ordinal'], row.get('expected'), timing,
                               row['status'])
        elif event == 'handoff':
            remaining = row.get('remainingMs')
            if (row.get('closedRoutes') != {'start': 503, 'callback': 503, 'result': 503}
                    or not isinstance(remaining, list) or len(remaining) != issued_count
                    or not all(finite_number(value) for value in remaining)):
                raise ValueError('invalid closed-route observation')
            for ordinal, value in enumerate(remaining, start=1):
                observe_remaining(ordinal, value)
            observation = ('handoff',)
        elif event == 'admission-refusal':
            if (row.get('controls') != ['unknown-target', 'missing-clock']
                    or type(row.get('status')) is not int or row['status'] != 503):
                raise ValueError('invalid admission refusal observation')
            observation = ('admission-refusal',)
        elif fence:
            elapsed = row.get('elapsedMs')
            skew = row.get('skewMs')
            if (not finite_number(elapsed) or not finite_number(skew)
                    or skew < 0 or elapsed < 120_000 + skew):
                raise ValueError('incomplete legacy fence observation')
            observation = ('legacy-fence-complete',)
        elif replacement or complete:
            observation = ('replacement' if replacement else 'complete',)
        else:
            continue
        observations.append((row.get('row'), observation))
    for live_return in (False, True):
        expected = [('Sign-in ' + stage, observation)
                    for stage, required in zip(stages, required_observations(previous_version, live_return))
                    for observation in required]
        if observations == expected:
            break
    else:
        raise ValueError('missing, extra, or out-of-order sign-in observations')
    return {'stages': stages, 'sha256': hashlib.sha256(raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('proof', type=Path)
    parser.add_argument('--previous-version', type=int, required=True)
    parser.add_argument('--candidate-version', type=int, required=True)
    parser.add_argument('--expected-cluster', required=True)
    args = parser.parse_args()
    try:
        result = read_proof(args.proof, args.previous_version, args.candidate_version,
                            args.expected_cluster)
    except (OSError, ValueError):
        print('Sign-in proof refused', file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())

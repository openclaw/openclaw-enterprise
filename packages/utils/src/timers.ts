/**
 * The longest delay a Node.js timer honours. A longer delay (up to 2^53 passes the safe-integer
 * check) fires after 1 ms instead, so a poll waits not at all and a deadline lapses at once
 * (findings 2303, 2309). Callers keep their own setting names and error messages.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Runs the real Driver and host helper. SSH and systemd are replaced by fixtures;
// only tests/integration/ssh-compute-real.test.mjs provides opt-in host proof.
import "./ssh-compute-admission-cases.ts";
import "./ssh-compute-ownership-cases.ts";
import "./ssh-compute-authentication-cases.ts";
import "./ssh-compute-retirement-cases.ts";
import "./ssh-compute-lock-and-cutover-cases.ts";
import "./ssh-compute-workspace-setup-cases.ts";
import "./ssh-compute-executor-cases.ts";

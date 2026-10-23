#!/usr/bin/env node
// Prints why Kubernetes would refuse the image reference given as the only argument
// ("uppercase-repository" or "invalid"), or nothing when it accepts it. The bash image tools
// call this so they share the rule of profile preflight, Compute and the chart.
import { imageReferenceProblem } from "../../packages/occ/src/image-reference.ts";

if (process.argv.length !== 3) {
  process.stderr.write("usage: image-reference-problem.mjs IMAGE\n");
  process.exit(2);
}
process.stdout.write(imageReferenceProblem(process.argv[2]) ?? "");

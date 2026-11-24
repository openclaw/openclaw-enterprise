#!/usr/bin/env node
// Prints why Kubernetes would refuse the image reference given as the only argument
// ("uppercase-repository" or "invalid"), or nothing when it accepts it. The bash image tools
// call this so they share the rule of profile preflight, Compute and the chart.
import { imageReferenceProblem } from "../../packages/occ/src/image-reference.ts";

const image = process.argv[2];
if (process.argv.length !== 3 || image === undefined) {
  process.stderr.write("usage: image-reference-problem.ts IMAGE\n");
  process.exit(2);
}
process.stdout.write(imageReferenceProblem(image) ?? "");

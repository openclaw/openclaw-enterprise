import fs from "node:fs";
import path from "node:path";
import { operatorCustomResourceDefinitions } from "../apps/operator/src/index.ts";

const check = process.argv.includes("--check");
const directory = path.resolve("deploy/helm/openclaw-enterprise-operator/crds");
fs.mkdirSync(directory, { recursive: true });
for (const crd of operatorCustomResourceDefinitions()) {
  const file = path.join(directory, `${crd.metadata.name}.yaml`);
  // JSON is a YAML subset; the generated structural schema has one source of truth.
  const contents = `${JSON.stringify(crd, null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== contents) {
      throw new Error(`Regenerate Operator CRDs: ${path.relative(process.cwd(), file)}`);
    }
  } else {
    fs.writeFileSync(file, contents);
  }
}
console.log(`Operator CRDs ${check ? "verified" : "generated"}.`);

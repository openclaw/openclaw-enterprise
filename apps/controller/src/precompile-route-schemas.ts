// Precompiles the API's request validators and response serializers into
// apps/controller/dist/route-compilers.cjs (or the path given), so a process that builds the
// app loads them instead of compiling each schema at startup. Run at image build time and by
// the CI lanes that build many apps; see http/route-compilers.ts.
import {
  generatePrecompiledRouteCompilers,
  PRECOMPILED_ROUTE_COMPILERS_PATH,
  writePrecompiledRouteCompilers,
} from "./http/route-compilers.ts";
import { createRouteGenerationApp } from "./route-generation-app.ts";

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1) {
  throw new Error("Usage: node apps/controller/src/precompile-route-schemas.ts [output]");
}
const output = arguments_[0] ?? PRECOMPILED_ROUTE_COMPILERS_PATH;

const { source, validators, serializers } = await generatePrecompiledRouteCompilers(async () => {
  const app = createRouteGenerationApp();
  try {
    await app.ready();
  } finally {
    await app.close();
  }
});
writePrecompiledRouteCompilers(output, source);
process.stdout.write(
  `precompile-route-schemas: ${validators} validators and ${serializers} serializers in ${output}\n`,
);

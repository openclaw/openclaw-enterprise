// Precompiles the API's request validators and response serializers into
// apps/controller/dist/route-compilers.cjs (or the path given), so a process that builds the
// app loads them instead of compiling each schema at startup. Run at image build time and by
// the CI lanes that build many apps; see http/route-compilers.ts.
import { createFastifyApp } from "./index.ts";
import {
  generatePrecompiledRouteCompilers,
  PRECOMPILED_ROUTE_COMPILERS_PATH,
  writePrecompiledRouteCompilers,
} from "./http/route-compilers.ts";

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1) {
  throw new Error("Usage: node apps/controller/src/precompile-route-schemas.mjs [output]");
}
const output = arguments_[0] ?? PRECOMPILED_ROUTE_COMPILERS_PATH;

const { source, validators, serializers } = await generatePrecompiledRouteCompilers(async () => {
  // Route registration does not depend on the drivers, so the same minimal development app
  // the OpenAPI generator builds registers every route with its production schemas.
  const app = createFastifyApp({
    development: { enabled: true, installationId: "ins_6054d30d-0f89-4cd0-aa56-2b76e3c5fb52" },
  });
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

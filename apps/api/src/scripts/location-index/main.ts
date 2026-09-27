// Builds the location index snapshot of a rules pack from OpenStreetMap (doc-3 §4); needs the network, unless
// every answer is cached:
//   pnpm --filter @otkryvay/api location-index --pack kazan-coffee [--counts] [--date T] [--cache-dir DIR] [--offline] [--out FILE]
// Offline shell code: excluded from the build of the API (tsconfig.build.json), never in the Docker image.
import { CONTENT_DIR } from '../../shell/content/load.js';
import { runLocationIndexCli } from './cli.js';

process.exitCode = await runLocationIndexCli(process.argv.slice(2), {
  env: process.env,
  // pnpm runs the script in apps/api; relative paths are meant from where pnpm was started.
  cwd: process.env.INIT_CWD ?? process.cwd(),
  contentDir: CONTENT_DIR,
  fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  random: Math.random,
  out: (line) => console.log(line),
  log: (line) => console.error(line),
});

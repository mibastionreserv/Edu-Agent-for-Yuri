// simli-client@3.x ships dist/index.js requiring "./Client" but the file on
// disk is dist/client.js (lowercase). Harmless on case-insensitive filesystems
// (macOS/Windows) but breaks Vite's build on Linux/CI with
// "Could not resolve './Client'". Runs automatically via npm postinstall so
// every environment (local, CI, Docker) gets the alias without a manual step.
// Safe to remove once upstream fixes it.
import { existsSync, copyFileSync } from 'node:fs';

const pairs = [
  ['node_modules/simli-client/dist/client.js', 'node_modules/simli-client/dist/Client.js'],
  ['node_modules/simli-client/dist/client.d.ts', 'node_modules/simli-client/dist/Client.d.ts'],
];

for (const [source, dest] of pairs) {
  if (existsSync(source) && !existsSync(dest)) {
    copyFileSync(source, dest);
  }
}

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const required = [
  'README.md', 'LICENSE', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json', 'tsconfig.json',
  'docs/architecture.md', 'docs/roadmap.md', 'docs/development.md',
  'docs/assets/desktop-demo.png', 'tests/acceptance/R1-A/run.mjs',
  'tests/acceptance/R1-A/core.acceptance.test.ts',
  'packages/contracts/src/index.ts', 'packages/device-bridge/src/index.ts',
  'packages/core/src/index.ts', 'packages/mcp-server/src/stdio.ts',
  'apps/desktop/src/main.ts', 'apps/desktop/scripts/build.mjs',
];

for (const relative of required) {
  try { await access(path.join(root, relative)); }
  catch { failures.push(`Missing ${relative}`); }
}

try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const names = new Set();
  for (const workspace of manifest.workspaces) {
    const module = JSON.parse(await readFile(path.join(root, workspace, 'package.json'), 'utf8'));
    if (names.has(module.name)) failures.push(`Duplicate workspace: ${module.name}`);
    names.add(module.name);
    if (module.license !== 'MIT') failures.push(`Missing project license: ${workspace}`);
  }
} catch (error) {
  failures.push(error.message);
}

console.log(JSON.stringify({
  status: failures.length ? 'FAIL' : 'SOURCE_LAYOUT_PASS',
  meaning: 'Public source layout only; no runtime or real-device acceptance implied',
  failures,
}, null, 2));
process.exitCode = failures.length ? 1 : 0;

import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const testFile = 'tests/acceptance/R1-A/core.acceptance.test.ts';
const requiredFiles = [
  'packages/contracts/src/index.ts',
  'packages/device-bridge/src/index.ts',
  'packages/core/src/index.ts',
  'packages/mcp-server/src/index.ts',
  'apps/desktop/index.html',
  testFile,
];
const requiredDirectories = ['apps/desktop/src'];
const hashRoots = [
  'packages/contracts/src',
  'packages/device-bridge/src',
  'packages/core/src',
  'packages/mcp-server/src',
  'apps/desktop/index.html',
  'apps/desktop/scripts',
  'apps/desktop/src',
  'tests/acceptance/R1-A',
];

async function exists(relative) {
  try {
    await access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(relative) {
  const absolute = path.join(root, relative);
  const info = await stat(absolute);
  if (info.isFile()) return [relative.replaceAll('\\', '/')];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) nested.push(...await collectFiles(child));
    else if (/\.(?:ts|tsx|mjs|html)$/.test(entry.name)) nested.push(child.replaceAll('\\', '/'));
  }
  return nested;
}

async function fileHashes() {
  const paths = [];
  for (const relative of hashRoots) {
    if (await exists(relative)) paths.push(...await collectFiles(relative));
  }
  const unique = [...new Set(paths)].sort();
  return Promise.all(unique.map(async (relative) => {
    const data = await readFile(path.join(root, relative));
    return {
      path: relative,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }));
}

async function runTests() {
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, '--test', path.join(root, testFile)], {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const timeout = setTimeout(() => child.kill(), 60_000);
  const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
  clearTimeout(timeout);
  return { exitCode, stdoutTail: stdout.slice(-8_000), stderrTail: stderr.slice(-8_000) };
}

const startedAt = new Date().toISOString();
const missing = [];
for (const relative of [...requiredFiles, ...requiredDirectories, 'node_modules/tsx/dist/cli.mjs']) {
  if (!(await exists(relative))) missing.push(relative);
}
const hashes = await fileHashes();

if (missing.length > 0) {
  const record = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: 'NOT_RUN_DEPENDENCY_MISSING',
    exitCode: 2,
    missing,
    hashes,
  };
  process.stdout.write(`\nR1A_ACCEPTANCE_RECORD=${JSON.stringify(record, null, 2)}\n`);
  process.exitCode = 2;
} else {
  const result = await runTests();
  const record = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.exitCode === 0 ? 'PASS' : 'FAIL',
    exitCode: result.exitCode,
    missing: [],
    hashes,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  };
  process.stdout.write(`\nR1A_ACCEPTANCE_RECORD=${JSON.stringify(record, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

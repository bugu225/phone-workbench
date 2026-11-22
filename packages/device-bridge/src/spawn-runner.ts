/// <reference types="node" />

import { spawn } from 'node:child_process';

import type { AdbCommandResult, AdbCommandRunner } from './index.ts';

export const MAX_ADB_OUTPUT_BYTES = 256 * 1024;

export class AdbOutputLimitError extends Error {
  readonly code = 'ADB_OUTPUT_LIMIT';

  constructor() {
    super('ADB command output exceeded the configured limit');
    this.name = 'AdbOutputLimitError';
  }
}

export class AdbSpawnUnavailableError extends Error {
  readonly code = 'ADB_SPAWN_UNAVAILABLE';

  constructor() {
    super('ADB executable could not be started');
    this.name = 'AdbSpawnUnavailableError';
  }
}

function isMissingExecutable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Production-only runner. The adapter invokes it solely with `devices -l`. */
export function createSpawnAdbRunner(): AdbCommandRunner {
  return (executable, args, options) => {
    if (args.length !== 2 || args[0] !== 'devices' || args[1] !== '-l') {
      return Promise.reject(new TypeError('Only the fixed ADB discovery command is allowed'));
    }

    return new Promise<AdbCommandResult>((resolve, reject) => {
      let settled = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const settleResolve = (result: AdbCommandResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const settleReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(isMissingExecutable(error) ? new AdbSpawnUnavailableError() : error);
      };

      let child;
      try {
        child = spawn(executable, [...args], {
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: options.signal,
        });
      } catch (error) {
        settleReject(error);
        return;
      }

      const collect = (target: Buffer[], chunk: Buffer | string): void => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.byteLength;
        if (outputBytes > MAX_ADB_OUTPUT_BYTES) {
          child.kill();
          settleReject(new AdbOutputLimitError());
          return;
        }
        target.push(bytes);
      };

      child.stdout.on('data', (chunk: Buffer | string) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer | string) => collect(stderr, chunk));
      child.on('error', settleReject);
      child.on('close', (exitCode: number | null) => {
        settleResolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
        });
      });
    });
  };
}

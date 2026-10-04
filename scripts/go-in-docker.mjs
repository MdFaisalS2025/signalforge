#!/usr/bin/env node
// Runs Go commands for services/collector-go inside the pinned official Go builder image.
// Usage: node scripts/go-in-docker.mjs [--network <name>] [--env KEY=VALUE]... <go command...>
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GO_IMAGE =
  'golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GO_DIR = path.join(REPO, 'services', 'collector-go');

export function parseWrapperArgs(argv) {
  const networkArgs = [];
  const envArgs = [];
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const flag = argv[index];
    if (flag === '--network') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--network requires a network name');
      }
      networkArgs.push('--network', value);
      index += 2;
    } else if (flag === '--env') {
      const value = argv[index + 1];
      if (value === undefined || !value.includes('=')) {
        throw new Error('--env requires KEY=VALUE');
      }
      envArgs.push('-e', value);
      index += 2;
    } else {
      throw new Error(`unknown wrapper flag: ${flag}`);
    }
  }
  const goArgs = argv.slice(index);
  if (goArgs.length === 0) {
    throw new Error('a Go command is required, for example: go version');
  }
  return { networkArgs, envArgs, goArgs };
}

export function buildDockerArgs(goDir, { networkArgs, envArgs, goArgs }) {
  return [
    'run', '--rm',
    ...networkArgs,
    ...envArgs,
    '-v', `${goDir}:/src`,
    '-w', '/src',
    '-e', 'CGO_ENABLED=0',
    GO_IMAGE,
    ...goArgs,
  ];
}

function main() {
  let parsed;
  try {
    parsed = parseWrapperArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const child = spawn('docker', buildDockerArgs(GO_DIR, parsed), {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (err) => {
    console.error(`failed to start docker: ${err.message}`);
    process.exit(1);
  });
  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}

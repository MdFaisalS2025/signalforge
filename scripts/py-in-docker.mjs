#!/usr/bin/env node
// Runs Python commands for services/agent-python inside the pinned dependency image. The image is built from the
// `deps` stage of services/agent-python/Dockerfile, so no Python is needed on the host.
// Usage: node scripts/py-in-docker.mjs [--network <name>] [--env KEY=VALUE]... <python command...>
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEPS_IMAGE = 'signalforge-agent-deps';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const pyArgs = argv.slice(index);
  if (pyArgs.length === 0) {
    throw new Error('a Python command is required, for example: python -V');
  }
  return { networkArgs, envArgs, pyArgs };
}

// Builds only the `deps` stage, with the repository root as the build context.
export function buildImageArgs(repoRoot) {
  return [
    'build',
    '--quiet',
    '-f', path.join(repoRoot, 'services', 'agent-python', 'Dockerfile'),
    '--target', 'deps',
    '-t', DEPS_IMAGE,
    repoRoot,
  ];
}

// The repository is mounted read-only. PYTHONDONTWRITEBYTECODE keeps Python from trying to write into it.
export function buildDockerArgs(repoRoot, { networkArgs, envArgs, pyArgs }) {
  return [
    'run', '--rm',
    ...networkArgs,
    ...envArgs,
    '-v', `${repoRoot}:/repo:ro`,
    '-w', '/repo/services/agent-python',
    '-e', 'PYTHONPATH=src',
    '-e', 'PYTHONDONTWRITEBYTECODE=1',
    DEPS_IMAGE,
    ...pyArgs,
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
  // The build is quiet and its stdout is discarded, so the Python command's output is the only thing on stdout.
  const build = spawnSync('docker', buildImageArgs(REPO), {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });
  if (build.error) {
    console.error(`failed to start docker: ${build.error.message}`);
    process.exit(1);
  }
  if (build.status !== 0) {
    console.error(`building ${DEPS_IMAGE} failed with exit code ${build.status}`);
    process.exit(build.status ?? 1);
  }
  const child = spawn('docker', buildDockerArgs(REPO, parsed), {
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

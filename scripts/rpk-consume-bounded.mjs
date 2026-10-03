import { spawn } from 'node:child_process';

export const COMPOSE_FILE = 'infra/docker/docker-compose.yml';
export const DEFAULT_TIMEOUT_MS = 5000;

export class BoundedConsumeTimeoutError extends Error {
  constructor(timeoutMs, stdout) {
    super(`bounded consume timed out after ${timeoutMs}ms`);
    this.name = 'BoundedConsumeTimeoutError';
    this.stdout = stdout;
  }
}

export function buildConsumeArgs({ topic, num, offset }) {
  return [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'redpanda',
    'rpk', 'topic', 'consume', topic,
    '--brokers', 'redpanda:9092',
    '--offset', offset,
    '--num', String(num),
    '--format', 'json',
    '--pretty-print=false',
  ];
}

// Only newline-terminated lines are complete. The text after the last newline is a partial
// record while the child is still writing, so it is dropped. A complete line that is not
// valid JSON is an error, because silently skipping it would hide corrupted output.
export function parseRecords(text) {
  const segments = text.split('\n');
  const complete = segments.slice(0, -1);
  const records = [];
  for (const segment of complete) {
    const line = segment.trim();
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid JSON record: ${line}`);
    }
  }
  return records;
}

export function runBounded(args, { command = 'docker', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new BoundedConsumeTimeoutError(timeoutMs, stdout));
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

export async function consumeBounded({
  topic,
  num,
  offset,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  command = 'docker',
  commandArgsPrefix = [],
}) {
  const args = [...commandArgsPrefix, ...buildConsumeArgs({ topic, num, offset })];
  const output = await runBounded(args, { command, timeoutMs });
  return parseRecords(output);
}

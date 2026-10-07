import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import DemoPage from './page';

// The exact commands from docs/specs/2026-10-06-incident-dashboard.md, section 10.
const STEP_1 =
  'docker compose -f infra/docker/docker-compose.yml up -d --build redpanda redpanda-init clickhouse otel-collector collector-go demo-orders demo-payments web';
const STEP_2 = 'node scripts/deploy-payments.mjs --version 0.2.0-faulty --fault enabled';
const STEP_3 = [
  'curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\\"order_id\\":\\"11111111-1111-4111-8111-111111111111\\",\\"item\\":\\"demo-keyboard\\",\\"amount_cents\\":4999}"',
  'curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\\"order_id\\":\\"22222222-2222-4222-8222-222222222222\\",\\"item\\":\\"demo-mouse\\",\\"amount_cents\\":1999}"',
  'curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\\"order_id\\":\\"33333333-3333-4333-8333-333333333333\\",\\"item\\":\\"demo-monitor\\",\\"amount_cents\\":19999}"',
];
const STEP_5 = 'node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled';
const TEARDOWN = 'docker compose -f infra/docker/docker-compose.yml down';

const decode = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const markup = renderToStaticMarkup(<DemoPage />);
const blocks = [...markup.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) => decode(m[1]));

test('every command from spec section 10 appears in its own copy-ready code block', () => {
  assert.equal(blocks.length, 5, 'one block per command step, plus teardown');
  assert.ok(blocks.includes(STEP_1));
  assert.ok(blocks.includes(STEP_2));
  assert.ok(blocks.includes(STEP_3.join('\n')));
  assert.ok(blocks.includes(STEP_5));
  assert.ok(blocks.includes(TEARDOWN));
});

test('the three order commands are exact, one per line, in a single block', () => {
  const block = blocks.find((b) => b.includes('11111111-1111-4111-8111-111111111111'))!;
  assert.deepEqual(block.split('\n'), STEP_3);
});

test('the teardown command does not remove volumes', () => {
  assert.ok(!blocks.some((b) => /\s-v(\s|$)|--volumes/.test(b)));
});

test('each step has expected-result text', () => {
  const text = decode(markup);
  for (const expectation of [
    'Expect web to start after ClickHouse is healthy',
    'http://localhost:3000/demo',
    'deployment_id=<uuid>',
    'Each returns HTTP 502 with a payment_unavailable reason',
    'The new row appears after Refresh',
    'The incident remains, because it is historical',
  ]) {
    assert.ok(text.includes(expectation), `missing expected-result text: ${expectation}`);
  }
});

test('the demo page has the shell with Demo selected', () => {
  assert.match(markup, /<a [^>]*href="\/demo"[^>]*aria-current="page"/);
});

test('the page source imports no service, ClickHouse client, API route, or live-data mechanism', () => {
  const source = readFileSync(join(import.meta.dirname, 'page.tsx'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  for (const specifier of imports) {
    assert.ok(!/service|clickhouse|queries|model|\/api\//.test(specifier), `forbidden import: ${specifier}`);
  }
  assert.ok(!/\bfetch\s*\(/.test(source), 'the demo page must not call fetch');
  assert.ok(!/getDashboardService|createClickHouse/.test(source));
});

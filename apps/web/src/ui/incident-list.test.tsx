import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { IncidentList, type IncidentListState } from './incident-list';
import { Shell } from './shell';
import type { IncidentItem } from '../server/model';

// Static rendering only: no browser, no live API, no client-side effects run here.
const ID_A = 'e53eb170-13e0-5ea4-b38e-3738b5013ce4';
const ID_B = '64d254ef-85a6-51ef-b4ab-80bc16c71baa';

function incident(overrides: Partial<IncidentItem> = {}): IncidentItem {
  return {
    incident_id: ID_A,
    revision: 2,
    title: 'Payments 5xx burst after deployment c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d',
    status: 'open',
    severity: 'high',
    service: 'demo-payments',
    environment: 'local',
    deployment_id: 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d',
    deployment_version: '0.2.0-faulty',
    trigger_rule: 'payments-5xx-burst-after-deployment',
    started_at: '2026-10-03T12:00:05.123000000Z',
    detected_at: '2026-10-03T12:00:12.456000000Z',
    publication_state: 'published',
    published_at: '2026-10-03T12:00:13.001000000Z',
    ...overrides,
  };
}

function render(state: IncidentListState): string {
  return renderToStaticMarkup(<IncidentList state={state} />);
}

// Counts non-overlapping occurrences of a literal string in markup.
function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

test('the empty state says "No incidents yet." and links to the demo page', () => {
  const markup = render({ kind: 'empty' });
  assert.ok(markup.includes('No incidents yet.'), 'empty state text is missing');
  assert.match(markup, /<a href="\/demo"[^>]*>[^<]*demo flow[^<]*<\/a>/);
});

test('the error state says "ClickHouse is unavailable." and offers a real Refresh control', () => {
  const markup = render({ kind: 'error' });
  assert.ok(markup.includes('ClickHouse is unavailable.'), 'error text is missing');
  assert.match(markup, /<button type="submit"[^>]*>Refresh<\/button>/, 'Refresh must be a submit button');
  assert.match(markup, /<form[^>]*method="get"[^>]*>/, 'Refresh must submit a GET form');
});

test('the loading state renders exactly five skeleton rows and is announced as busy', () => {
  const markup = render({ kind: 'loading' });
  assert.equal(count(markup, 'data-skeleton-row'), 5);
  assert.ok(markup.includes('aria-busy="true"'), 'loading state must set aria-busy="true"');
});

test('a loaded row shows severity as a dot plus the visible word', () => {
  const markup = render({ kind: 'loaded', incidents: [incident()] });
  assert.match(markup, /<span[^>]*data-severity="high"[^>]*>[\s\S]*?<\/span>\s*high/);
  assert.match(markup, /<span[^>]*aria-hidden="true"[^>]*><\/span>/, 'the dot must be decorative');
});

test('a loaded row shows publication state as text, so pending and published survive without color', () => {
  const published = render({ kind: 'loaded', incidents: [incident({ publication_state: 'published' })] });
  assert.ok(published.includes('>published<'), 'published must be visible text');

  const pending = render({
    kind: 'loaded',
    incidents: [incident({ publication_state: 'pending', published_at: null })],
  });
  assert.ok(pending.includes('>pending<'), 'pending must be visible text');
});

test('a loaded row shows service, deployment version, and the UTC detected time', () => {
  const markup = render({ kind: 'loaded', incidents: [incident()] });
  assert.ok(markup.includes('demo-payments'));
  assert.ok(markup.includes('0.2.0-faulty'));
  assert.ok(markup.includes('2026-10-03T12:00:12.456000000Z'), 'the visible time must be the exact UTC text');
});

test('the detected time carries a title attribute, with the UTC value as the server-rendered fallback', () => {
  const markup = render({ kind: 'loaded', incidents: [incident()] });
  assert.match(markup, /<time[^>]*title="[^"]*2026-10-03T12:00:12\.456000000Z[^"]*"/);
});

test('each incident links to its detail page', () => {
  const markup = render({ kind: 'loaded', incidents: [incident(), incident({ incident_id: ID_B })] });
  assert.ok(markup.includes(`href="/incidents/${ID_A}"`));
  assert.ok(markup.includes(`href="/incidents/${ID_B}"`));
});

test('a missing deployment version renders a dash, never the word null', () => {
  const markup = render({ kind: 'loaded', incidents: [incident({ deployment_version: null })] });
  assert.ok(!markup.includes('>null<'), 'null must not be shown as text');
  assert.ok(markup.includes('—'), 'a dash marks the missing version');
});

test('the loaded header reports how many incidents are shown', () => {
  const markup = render({ kind: 'loaded', incidents: [incident(), incident({ incident_id: ID_B })] });
  assert.match(markup, />2 loaded</);
});

test('the shell has exactly three navigation entries: Incidents, Deployments, Demo', () => {
  const markup = renderToStaticMarkup(
    <Shell current="incidents">
      <p>content</p>
    </Shell>,
  );
  const nav = /<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/.exec(markup);
  assert.ok(nav, 'primary navigation is missing');
  const labels = [...nav[1].matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Incidents', 'Deployments', 'Demo']);
  assert.ok(markup.includes('<p>content</p>'), 'the shell must render its children');
});

test('a published incident shows its exact published_at in a publication-state tooltip', () => {
  const markup = render({ kind: 'loaded', incidents: [incident({ publication_state: 'published' })] });
  const tag = /<span[^>]*data-publication="published"[^>]*>/.exec(markup)?.[0] ?? '';
  assert.ok(tag.length > 0, 'the published status element must render');
  assert.match(tag, /title="[^"]*2026-10-03T12:00:13\.001000000Z[^"]*"/, 'the tooltip must carry the full-precision published_at');
});

test('a pending incident has no publication tooltip and invents no published time', () => {
  const markup = render({
    kind: 'loaded',
    incidents: [incident({ publication_state: 'pending', published_at: null })],
  });
  const tag = /<span[^>]*data-publication="pending"[^>]*>/.exec(markup)?.[0] ?? '';
  assert.ok(tag.length > 0, 'the pending status element must render');
  assert.doesNotMatch(tag, /title=/);
  assert.doesNotMatch(markup, /Published|published at/i);
});

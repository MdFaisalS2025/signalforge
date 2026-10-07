import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeployTimeline, FOOTNOTE, type DeployTimelineState } from './deploy-timeline';
import type { DeploymentItem } from '../server/model';

// Static rendering only: no browser, no live API, no client state.
const D_OLD = '6144d723-a25b-407c-a50c-ae83e454a849';
const D_MID = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';
const D_NEW = 'b8a09870-65f0-407a-baa2-ee772ecea58c';
const INCIDENT = '20853c34-6c98-53b0-8bc7-1f7250e1921d';

function deployment(overrides: Partial<DeploymentItem> = {}): DeploymentItem {
  return {
    deployment_id: D_MID,
    timestamp: '2026-10-06T17:11:00.000000000Z',
    environment: 'local',
    new_version: '0.2.0-faulty',
    status: 'succeeded',
    class: 'faulty',
    failing_traces: 3,
    incident_ids: [INCIDENT],
    ...overrides,
  };
}

const healthy = deployment({
  deployment_id: D_OLD,
  timestamp: '2026-10-06T13:00:00.000000000Z',
  new_version: '0.1.0',
  class: 'healthy',
  failing_traces: 0,
  incident_ids: [],
});
const faulty = deployment();
const restored = deployment({
  deployment_id: D_NEW,
  timestamp: '2026-10-06T17:30:00.123456789Z',
  new_version: '0.1.0',
  class: 'healthy',
  failing_traces: 0,
  incident_ids: [],
});

const render = (state: DeployTimelineState) => renderToStaticMarkup(<DeployTimeline state={state} />);
const loaded = (deployments: DeploymentItem[]) => render({ kind: 'loaded', deployments });
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

type Marker = { id: string; cls: string; x: number; markup: string };

function markers(markup: string): Marker[] {
  return [...markup.matchAll(/<g [^>]*data-marker="deployment"[^>]*>[\s\S]*?<\/g>/g)].map((match) => {
    const head = match[0].slice(0, match[0].indexOf('>') + 1);
    return {
      id: /data-deployment="([^"]*)"/.exec(head)?.[1] ?? '',
      cls: /data-class="([^"]*)"/.exec(head)?.[1] ?? '',
      x: Number(/data-x="([^"]*)"/.exec(head)?.[1]),
      markup: match[0],
    };
  });
}

test('a faulty deployment has a red-class marker, fault wording, the failure count, and a link to its incident', () => {
  const [marker] = markers(loaded([faulty]));
  assert.equal(marker.cls, 'faulty');
  assert.match(marker.markup, /<polygon[^>]*class="marker-faulty"/, 'faulty uses its own shape');
  assert.ok(marker.markup.includes('Faulty: 3 HTTP 500 traces'), 'fault wording and count must be visible');
  assert.match(marker.markup, /<line[^>]*class="timeline-connector"/, 'a connector must join the incident');
  assert.match(marker.markup, new RegExp(`<a [^>]*href="/incidents/${INCIDENT}"`));
});

test('a healthy deployment has a green-class marker and says "No failures observed"', () => {
  const [marker] = markers(loaded([healthy]));
  assert.equal(marker.cls, 'healthy');
  assert.match(marker.markup, /<circle[^>]*class="marker-healthy"/);
  assert.ok(marker.markup.includes('No failures observed'));
  assert.ok(!marker.markup.includes('timeline-connector'), 'no connector without an incident');
});

test('timeline markers run oldest to newest, whatever order the deployments arrive in', () => {
  const found = markers(loaded([restored, faulty, healthy]));
  assert.deepEqual(found.map((m) => m.id), [D_OLD, D_MID, D_NEW]);
  const xs = found.map((m) => m.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs);
});

test('each marker shows its exact UTC timestamp, including all nine fractional digits', () => {
  const markup = loaded([healthy, faulty, restored]);
  assert.ok(markup.includes('2026-10-06T17:30:00.123456789Z'));
  assert.ok(markup.includes('2026-10-06T13:00:00.000000000Z'));
});

test('markers have ids so the incident page can link to /deployments#deployment-<id>', () => {
  const markup = loaded([faulty]);
  assert.ok(markup.includes(`id="deployment-${D_MID}"`));
});

test('the table shows time, version, class label, failure count, and a truncated incident link', () => {
  const markup = loaded([faulty, healthy]);
  const table = /<table[\s\S]*<\/table>/.exec(markup)![0];
  for (const heading of ['Deployed (UTC)', 'Version', 'Class', 'Failing traces', 'Incident']) {
    assert.ok(table.includes(`>${heading}<`), `missing column ${heading}`);
  }
  assert.ok(table.includes('0.2.0-faulty') && table.includes('0.1.0'));
  assert.ok(table.includes('Faulty: 3 HTTP 500 traces') && table.includes('No failures observed'));
  assert.match(table, new RegExp(`<a [^>]*href="/incidents/${INCIDENT}"[^>]*>${INCIDENT.slice(0, 8)}…</a>`));
  assert.ok(!table.includes(`>${INCIDENT}<`), 'the incident ID is truncated in the table');
});

test('a deployment with no incident shows a dash in the incident column', () => {
  const table = /<table[\s\S]*<\/table>/.exec(loaded([healthy]))![0];
  assert.ok(table.includes('—'));
});

test('the footnote says that "No failures observed" is not proof of health', () => {
  const markup = decode(loaded([healthy]));
  assert.equal(FOOTNOTE, '"No failures observed" is deliberately not "healthy". A deployment with no traffic is not proven healthy.');
  assert.ok(markup.includes(FOOTNOTE));
});

test('an unknown-status deployment shows its raw status, with a shape distinct from healthy and faulty', () => {
  const unknown = deployment({ status: 'failed', class: 'unknown', failing_traces: 0, incident_ids: [] });
  const [marker] = markers(loaded([unknown]));
  assert.equal(marker.cls, 'unknown');
  assert.match(marker.markup, />failed</);
  assert.match(marker.markup, /<circle[^>]*class="marker-unknown"/);
});

test('the SVG has an accessible role, title, and label', () => {
  const markup = loaded([faulty]);
  assert.match(markup, /<svg[^>]*role="img"[^>]*aria-labelledby="deploy-timeline-title"/);
  assert.match(markup, /<title id="deploy-timeline-title">[^<]*UTC[^<]*<\/title>/);
});

test('the empty state says exactly "No Payments deployments recorded yet." and links to /demo', () => {
  const markup = render({ kind: 'empty' });
  assert.ok(markup.includes('No Payments deployments recorded yet.'));
  assert.match(markup, /<a href="\/demo"/);
});

test('the error state says "ClickHouse is unavailable." with a GET Refresh control', () => {
  const markup = render({ kind: 'error' });
  assert.ok(markup.includes('ClickHouse is unavailable.'));
  assert.match(markup, /<form[^>]*method="get"[^>]*>/);
  assert.match(markup, /<button type="submit"[^>]*>Refresh<\/button>/);
});

test('the loading state renders five skeleton rows and is announced as busy', () => {
  const markup = render({ kind: 'loading' });
  assert.equal(markup.split('data-skeleton-row').length - 1, 5);
  assert.ok(markup.includes('aria-busy="true"'));
});

test('the loaded header reports how many deployments are shown', () => {
  assert.match(loaded([faulty, healthy]), />2 loaded</);
});

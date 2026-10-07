import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeployTimeline, FOOTNOTE, LABEL_CHAR_WIDTH, type DeployTimelineState } from './deploy-timeline';
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

// ---- Proportional UTC placement ----

const at = (id: string, time: string) =>
  deployment({ deployment_id: id, timestamp: `2026-10-06T${time}.000000000Z`, incident_ids: [], class: 'healthy', failing_traces: 0 });

const svgWidth = (markup: string) => Number(/<svg[^>]*width="(\d+(?:\.\d+)?)"/.exec(markup)![1]);

test('markers are placed in proportion to UTC time: 00:00, 00:10, and 01:40 put the middle one at 10%', () => {
  const markup = loaded([at(D_NEW, '01:40:00'), at(D_OLD, '00:00:00'), at(D_MID, '00:10:00')]);
  const [first, middle, last] = markers(markup);
  assert.deepEqual([first.id, middle.id, last.id], [D_OLD, D_MID, D_NEW]);
  const fraction = (middle.x - first.x) / (last.x - first.x);
  assert.ok(Math.abs(fraction - 0.1) < 0.01, `middle marker is at ${(fraction * 100).toFixed(1)}% of the axis, expected about 10%`);
});

test('the first and last markers anchor the two ends of the axis with equal padding', () => {
  const markup = loaded([at(D_OLD, '00:00:00'), at(D_MID, '00:10:00'), at(D_NEW, '01:40:00')]);
  const [first, , last] = markers(markup);
  assert.ok(first.x > 0);
  assert.ok(Math.abs(first.x - (svgWidth(markup) - last.x)) < 0.5, 'left and right padding must match');
});

test('nine-digit source timestamps are displayed unchanged while placement uses them', () => {
  const a = deployment({ deployment_id: D_OLD, timestamp: '2026-10-06T00:00:00.000000001Z', incident_ids: [], class: 'healthy', failing_traces: 0 });
  const b = deployment({ deployment_id: D_NEW, timestamp: '2026-10-06T00:00:00.999999999Z', incident_ids: [], class: 'healthy', failing_traces: 0 });
  const markup = loaded([b, a]);
  assert.ok(markup.includes('2026-10-06T00:00:00.000000001Z') && markup.includes('2026-10-06T00:00:00.999999999Z'));
  const [first, last] = markers(markup);
  assert.ok(last.x > first.x, 'sub-second differences still order the markers');
});

test('the timeline no longer says it is not to scale', () => {
  assert.ok(!loaded([at(D_OLD, '00:00:00'), at(D_NEW, '01:00:00')]).includes('not to scale'));
});

test('all-equal timestamps give finite, distinct, increasing positions and invent no times', () => {
  const same = (id: string) => at(id, '12:00:00');
  const markup = loaded([same(D_NEW), same(D_OLD), same(D_MID)]);
  const found = markers(markup);
  assert.equal(found.length, 3);
  for (const marker of found) assert.ok(Number.isFinite(marker.x), 'x must be a finite number');
  for (let i = 1; i < found.length; i += 1) assert.ok(found[i].x - found[i - 1].x >= 20, 'tied markers must not overlap');
  assert.ok(!markup.includes('NaN'));
  const shown = new Set(markup.match(/2026-10-06T[\d:.]+Z/g));
  assert.deepEqual([...shown], ['2026-10-06T12:00:00.000000000Z'], 'only the real time appears');
});

test('a single deployment is placed without dividing by zero', () => {
  const markup = loaded([at(D_OLD, '12:00:00')]);
  assert.ok(Number.isFinite(markers(markup)[0].x));
  assert.ok(!markup.includes('NaN'));
});

test('two deployments at the same instant among others are separated, others stay proportional', () => {
  const markup = loaded([at(D_OLD, '00:00:00'), at(D_MID, '00:10:00'), at(D_NEW, '00:10:00'), at('11111111-1111-4111-8111-111111111111', '01:40:00')]);
  const found = markers(markup);
  assert.ok(found[2].x - found[1].x >= 20, 'tied markers must not overlap');
  assert.ok(Math.abs((found[1].x - found[0].x) / (found[3].x - found[0].x) - 0.1) < 0.02);
});

// ---- Label lanes ----

// A cluster: four deployments inside one minute, between an early and a late one, so the cluster's proportional
// x-positions are only a few pixels apart while their labels are about 200px wide.
const CLUSTER_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
const INCIDENT_2 = '406a10b6-a366-5554-b8a1-1eb2d9a475d3';
function clusteredSet(): DeploymentItem[] {
  const base = (id: string, time: string, extra: Partial<DeploymentItem>) =>
    deployment({ deployment_id: id, timestamp: `2026-10-06T${time}.000000000Z`, ...extra });
  return [
    base(D_OLD, '10:00:00', { class: 'healthy', failing_traces: 0, incident_ids: [], new_version: '0.1.0' }),
    base(CLUSTER_IDS[0], '14:15:53', { new_version: '0.2.0-faulty' }),
    base(CLUSTER_IDS[1], '14:15:55', { new_version: '0.3.0-faulty', incident_ids: [INCIDENT_2] }),
    base(CLUSTER_IDS[2], '14:16:00', { class: 'healthy', failing_traces: 0, incident_ids: [], new_version: '0.1.0' }),
    base(CLUSTER_IDS[3], '14:16:52', { new_version: '0.4.0-faulty' }),
    base(D_NEW, '17:00:00', { class: 'healthy', failing_traces: 0, incident_ids: [], new_version: '0.1.0' }),
  ];
}
const SPREAD_SET = [at(D_OLD, '00:00:00'), at(D_MID, '06:00:00'), at(D_NEW, '12:00:00')];

type Label = { lane: number; text: string };

// Reads a marker's below-axis label lines and its incident label, from the rendered markup.
function labelsOf(marker: Marker): { below: Label[]; incident: Label | null } {
  const texts = [...marker.markup.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
    attrs: m[1],
    text: m[2],
  }));
  const pick = (kind: string) =>
    texts
      .filter((t) => t.attrs.includes(`data-label="${kind}"`))
      .map((t) => ({ lane: Number(/data-lane="(\d+)"/.exec(t.attrs)?.[1]), text: t.text }));
  return { below: pick('below'), incident: pick('incident')[0] ?? null };
}

function interval(x: number, labels: Label[]): [number, number] {
  const width = Math.max(...labels.map((l) => l.text.length)) * LABEL_CHAR_WIDTH;
  return [x - width / 2, x + width / 2];
}

// The fewest lanes that can hold intervals is the largest number of intervals covering one point.
function maxOverlap(intervals: Array<[number, number]>): number {
  const events = intervals.flatMap(([a, b]) => [[a, 1], [b, -1]] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let current = 0;
  let best = 0;
  for (const [, delta] of events) {
    current += delta;
    best = Math.max(best, current);
  }
  return best;
}

const svgHeight = (markup: string) => Number(/<svg[^>]*height="(\d+(?:\.\d+)?)"/.exec(markup)![1]);

function assertNoOverlapPerLane(entries: Array<{ lane: number; range: [number, number]; id: string }>) {
  for (const a of entries) {
    for (const b of entries) {
      if (a.id < b.id && a.lane === b.lane) {
        assert.ok(a.range[1] <= b.range[0] || b.range[1] <= a.range[0], `labels ${a.id} and ${b.id} overlap in lane ${a.lane}`);
      }
    }
  }
}

test('no two rendered labels collide: texts on one baseline never overlap horizontally', () => {
  const texts = [...loaded(clusteredSet()).matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => {
    const x = Number(/\bx="([\d.]+)"/.exec(m[0])![1]);
    const y = Number(/\by="([\d.]+)"/.exec(m[0])![1]);
    return { x, y, text: m[1], half: (m[1].length * LABEL_CHAR_WIDTH) / 2 };
  });
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      if (a.y !== b.y) continue;
      assert.ok(a.x + a.half <= b.x - b.half || b.x + b.half <= a.x - a.half, `"${a.text}" and "${b.text}" overlap at y=${a.y}`);
    }
  }
});

test('clustered markers keep their proportional x-positions', () => {
  const found = markers(loaded(clusteredSet()));
  const secondsOf = (id: string) => {
    const d = clusteredSet().find((item) => item.deployment_id === id)!;
    const [h, m, s] = d.timestamp.slice(11, 19).split(':').map(Number);
    return h * 3600 + m * 60 + s;
  };
  const first = found[0];
  const last = found[found.length - 1];
  const span = secondsOf(last.id) - secondsOf(first.id);
  for (const marker of found) {
    const expected = (secondsOf(marker.id) - secondsOf(first.id)) / span;
    const actual = (marker.x - first.x) / (last.x - first.x);
    assert.ok(Math.abs(actual - expected) < 0.001, `${marker.id} drifted: ${actual} vs ${expected}`);
  }
});

test('every marker stays on the single horizontal axis', () => {
  const markup = loaded(clusteredSet());
  const axisY = /<line[^>]*y1="([\d.]+)"[^>]*class="timeline-axis"/.exec(markup)![1];
  for (const cy of markup.matchAll(/<circle[^>]*cy="([\d.]+)"/g)) assert.equal(cy[1], axisY);
});

test('label lanes are deterministic, whatever order the deployments arrive in', () => {
  const lanes = (items: DeploymentItem[]) => markers(loaded(items)).map((m) => [m.id, labelsOf(m).below.map((l) => l.lane)]);
  assert.deepEqual(lanes(clusteredSet()), lanes([...clusteredSet()].reverse()));
});

test('labels in the same lane never overlap, using the documented width estimate', () => {
  const found = markers(loaded(clusteredSet()));
  assertNoOverlapPerLane(
    found.map((m) => ({ id: m.id, lane: labelsOf(m).below[0].lane, range: interval(m.x, labelsOf(m).below) })),
  );
});

test('incident link labels in the same lane never overlap either', () => {
  const found = markers(loaded(clusteredSet())).filter((m) => labelsOf(m).incident);
  assert.ok(found.length >= 3, 'the cluster must include several incident-linked deployments');
  assertNoOverlapPerLane(
    found.map((m) => ({ id: m.id, lane: labelsOf(m).incident!.lane, range: interval(m.x, [labelsOf(m).incident!]) })),
  );
});

test('the fewest possible lanes are used, for both below-axis and incident labels', () => {
  const found = markers(loaded(clusteredSet()));
  const below = found.map((m) => interval(m.x, labelsOf(m).below));
  const usedBelow = new Set(found.map((m) => labelsOf(m).below[0].lane)).size;
  assert.equal(usedBelow, maxOverlap(below));
  assert.ok(usedBelow > 1, 'the cluster must actually need more than one lane');

  const withIncident = found.filter((m) => labelsOf(m).incident);
  const above = withIncident.map((m) => interval(m.x, [labelsOf(m).incident!]));
  assert.equal(new Set(withIncident.map((m) => labelsOf(m).incident!.lane)).size, maxOverlap(above));
});

test('lane 0 is used first and lanes are contiguous', () => {
  const lanes = [...new Set(markers(loaded(clusteredSet())).map((m) => labelsOf(m).below[0].lane))].sort((a, b) => a - b);
  assert.deepEqual(lanes, lanes.map((_, i) => i));
});

test('a spread-out dataset stays in the base lane with no needless height', () => {
  const markup = loaded(SPREAD_SET);
  for (const marker of markers(markup)) assert.equal(labelsOf(marker).below[0].lane, 0);
  assert.ok(!markup.includes('timeline-leader'), 'no leader lines when nothing is displaced');
  assert.equal(svgHeight(markup), svgHeight(loaded([at(D_OLD, '00:00:00'), at(D_NEW, '20:00:00')])));
  assert.ok(svgHeight(loaded(clusteredSet())) > svgHeight(markup), 'only clustered data grows the SVG');
});

test('displaced labels get a leader line to their marker, and base-lane labels do not', () => {
  for (const marker of markers(loaded(clusteredSet()))) {
    const lane = labelsOf(marker).below[0].lane;
    const hasLeader = /<line[^>]*class="timeline-leader"/.test(marker.markup);
    assert.equal(hasLeader, lane > 0, `${marker.id} lane ${lane}`);
  }
});

test('the SVG is tall enough that no label clips at the top or bottom', () => {
  const markup = loaded(clusteredSet());
  const height = svgHeight(markup);
  const ys = [...markup.matchAll(/<text [^>]*\by="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(Math.min(...ys) >= 10, `top label at y=${Math.min(...ys)} is clipped`);
  assert.ok(Math.max(...ys) + 6 <= height, `bottom label at y=${Math.max(...ys)} exceeds height ${height}`);
});

test('clustered rendering keeps links, shapes, wording, and exact timestamps', () => {
  const markup = loaded(clusteredSet());
  assert.ok(markup.includes(`href="/incidents/${INCIDENT}"`) && markup.includes(`href="/incidents/${INCIDENT_2}"`));
  assert.ok(markup.includes('Faulty: 3 HTTP 500 traces') && markup.includes('No failures observed'));
  assert.ok(markup.includes('2026-10-06T14:15:53.000000000Z') && markup.includes('2026-10-06T14:16:52.000000000Z'));
  const found = markers(markup);
  assert.equal(found.filter((m) => m.markup.includes('class="marker-faulty"')).length, 3);
  assert.equal(found.filter((m) => m.markup.includes('class="marker-healthy"')).length, 3);
  assert.equal(markup.split('<tr id="row-').length - 1, 6, 'one table row per deployment');
});

test('the loaded header reports how many deployments are shown', () => {
  assert.match(loaded([faulty, healthy]), />2 loaded</);
});

test('every deployment marker has an SVG <title> with its exact deployment timestamp', () => {
  const ms = markers(loaded([healthy, faulty]));
  assert.equal(ms.length, 2);
  for (const marker of ms) {
    const title = /<title>([^<]*)<\/title>/.exec(marker.markup)?.[1] ?? '';
    const source = marker.id === faulty.deployment_id ? faulty : healthy;
    assert.ok(title.includes(source.timestamp), `marker ${marker.id} title "${title}" must include ${source.timestamp}`);
    assert.ok(title.includes(marker.id), 'the deployment ID stays in the tooltip');
  }
});

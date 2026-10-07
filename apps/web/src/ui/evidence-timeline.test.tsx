import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceTimeline } from './evidence-timeline';
import type { EvidenceItem } from '../server/model';

// Static rendering only: no browser, no live API, no client state.
const DEPLOYMENT_ID = 'c5ccccd9-119d-4a1c-91cd-b3f78ac84e2d';
const TRACE_1 = '70c13b1f8287d5205b842d532c6f09ea';
const TRACE_2 = '4955662a3ed95b514cd85676abb329b3';
const TRACE_3 = 'e1b78f9d0c507fd45879576baf849ff7';

function item(type: 'deployment' | 'trace', ref: string, timestamp: string): EvidenceItem {
  return {
    evidence_id: `ev-${ref.slice(0, 8)}`,
    source_type: type,
    source_ref: ref,
    timestamp,
    service: 'demo-payments',
    summary: type === 'deployment' ? 'demo-payments version 0.2.0-faulty deployed' : `HTTP 500 for trace ${ref}`,
    reliability: 'high',
  };
}

// Deliberately out of order, to prove the timeline sorts chronologically.
const FOUR: EvidenceItem[] = [
  item('trace', TRACE_2, '2026-10-03T12:01:10.500000000Z'),
  item('deployment', DEPLOYMENT_ID, '2026-10-03T12:00:00.000000000Z'),
  item('trace', TRACE_3, '2026-10-03T12:01:20.000000000Z'),
  item('trace', TRACE_1, '2026-10-03T12:01:05.123456789Z'),
];

const render = (items: EvidenceItem[]) => renderToStaticMarkup(<EvidenceTimeline items={items} />);

type Marker = { kind: string; ref: string; x: number; markup: string };

// Reads each marker group back out of the markup.
function markers(markup: string): Marker[] {
  return [...markup.matchAll(/<g [^>]*data-marker="([a-z]+)"[^>]*>([\s\S]*?)<\/g>/g)].map((match) => {
    const head = match[0].slice(0, match[0].indexOf('>') + 1);
    return {
      kind: match[1],
      ref: /data-ref="([^"]*)"/.exec(head)?.[1] ?? '',
      x: Number(/data-x="([^"]*)"/.exec(head)?.[1]),
      markup: match[0],
    };
  });
}

test('four items render one deployment marker and three trace markers', () => {
  const found = markers(render(FOUR));
  assert.equal(found.length, 4);
  assert.deepEqual(found.map((m) => m.kind).sort(), ['deployment', 'trace', 'trace', 'trace']);
});

test('markers appear in chronological order, whatever order the items arrive in', () => {
  const found = markers(render(FOUR));
  assert.deepEqual(found.map((m) => m.ref), [DEPLOYMENT_ID, TRACE_1, TRACE_2, TRACE_3]);
  const xs = found.map((m) => m.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'x positions must increase with time');
});

test('the deployment marker is green and trace markers are red, each with a distinct shape', () => {
  const found = markers(render(FOUR));
  const deployment = found.find((m) => m.kind === 'deployment')!;
  assert.match(deployment.markup, /<rect[^>]*class="marker-deployment"/);
  for (const trace of found.filter((m) => m.kind === 'trace')) {
    assert.match(trace.markup, /<circle[^>]*class="marker-trace"/);
  }
});

test('trace labels are the first 12 characters plus an ellipsis, with the full ID in a title', () => {
  const markup = render(FOUR);
  assert.ok(markup.includes(`${TRACE_1.slice(0, 12)}…`));
  const visibleTexts = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  assert.ok(!visibleTexts.some((text) => text.includes(TRACE_1)), 'the full ID must not be visible label text');
  assert.ok(markup.includes(`<title>${TRACE_1}</title>`) || markup.includes(`title="${TRACE_1}"`));
});

test('every marker shows its exact UTC timestamp as text, and a word naming its kind', () => {
  const found = markers(render(FOUR));
  const expected: Record<string, string> = {
    [DEPLOYMENT_ID]: '2026-10-03T12:00:00.000000000Z',
    [TRACE_1]: '2026-10-03T12:01:05.123456789Z',
    [TRACE_2]: '2026-10-03T12:01:10.500000000Z',
    [TRACE_3]: '2026-10-03T12:01:20.000000000Z',
  };
  for (const marker of found) {
    assert.ok(marker.markup.includes(expected[marker.ref]), `timestamp missing for ${marker.ref}`);
    assert.match(marker.markup, marker.kind === 'deployment' ? />deployment</ : />trace [0-9a-f]{12}…</, 'a word must name the kind');
  }
});

test('the SVG has an accessible role, title, and label', () => {
  const markup = render(FOUR);
  assert.match(markup, /<svg[^>]*role="img"[^>]*aria-labelledby="timeline-title"/);
  assert.match(markup, /<title id="timeline-title">[^<]*evidence[^<]*UTC[^<]*<\/title>/i);
});

test('fewer than four items shows a warning with the real count and only the supplied markers', () => {
  const two = FOUR.slice(0, 2);
  const markup = render(two);
  assert.match(markup, /role="status"[^>]*>[^<]*2 of 4[^<]*</);
  assert.equal(markers(markup).length, 2, 'no marker may be invented');
});

test('one item shows "1 of 4", and zero items shows "0 of 4" with no markers', () => {
  assert.match(render(FOUR.slice(0, 1)), />[^<]*1 of 4[^<]*</);
  const none = render([]);
  assert.match(none, />[^<]*0 of 4[^<]*</);
  assert.equal(markers(none).length, 0);
});

test('four items show no warning', () => {
  assert.ok(!render(FOUR).includes('role="status"'));
});

test('equal timestamps get distinct, non-overlapping, deterministic positions', () => {
  const same = '2026-10-03T12:01:05.000000000Z';
  const tied: EvidenceItem[] = [
    item('trace', TRACE_3, same),
    item('trace', TRACE_1, same),
    item('trace', TRACE_2, same),
    item('deployment', DEPLOYMENT_ID, same),
  ];
  const first = markers(render(tied));
  const second = markers(render([...tied].reverse()));
  assert.deepEqual(first.map((m) => [m.ref, m.x]), second.map((m) => [m.ref, m.x]), 'order must not depend on input order');
  assert.equal(first[0].kind, 'deployment', 'on a tie the deployment comes first');
  for (let i = 1; i < first.length; i += 1) {
    assert.ok(first[i].x - first[i - 1].x >= 100, `markers ${i - 1} and ${i} overlap`);
  }
});

test('close timestamps are spread apart enough that labels do not overlap', () => {
  const found = markers(render(FOUR));
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(found[i].x - found[i - 1].x >= 100, `markers ${i - 1} and ${i} are too close`);
  }
});

test('the axis names its UTC start and end', () => {
  const markup = render(FOUR);
  assert.match(markup, /data-axis="start"[^>]*>[^<]*2026-10-03T12:00:00\.000000000Z/);
  assert.match(markup, /data-axis="end"[^>]*>[^<]*2026-10-03T12:01:20\.000000000Z/);
});

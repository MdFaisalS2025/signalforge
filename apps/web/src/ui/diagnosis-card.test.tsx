import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagnosisCard } from './diagnosis-card';
import { installDashboardService, createDashboardService } from '../server/service';
import type { ClickHouseReader } from '../server/clickhouse';
import type { DiagnosisPayload } from '../server/diagnosis';
import type { EvidenceItem } from '../server/model';
import IncidentDetailPage from '../../app/incidents/[incidentId]/page';

// Static rendering only: no browser, no live API.
const SAMPLE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'contracts', 'events', 'samples', 'diagnosis.sample.json'), 'utf-8'),
) as Record<string, any>;
const INCIDENT_ID: string = SAMPLE.incident_id;
const DEPLOYMENT_EVIDENCE = '2b36dac1-5929-5a4f-9c94-5e46d810d714';
const CITED: string[] = [
  ...new Set<string>([
    ...SAMPLE.supporting_claims.flatMap((c: any) => c.evidence_ids),
    ...SAMPLE.alternative_hypotheses.flatMap((a: any) => a.disconfirming_evidence_ids),
  ]),
];

const evidence = (): EvidenceItem[] =>
  CITED.map((id) => ({
    evidence_id: id,
    source_type: id === DEPLOYMENT_EVIDENCE ? 'deployment' : 'trace',
    source_ref: id === DEPLOYMENT_EVIDENCE ? '57d9bf44-46c0-46e9-8140-4a7b9f3694a8' : `trace-${id.slice(0, 4)}`,
    timestamp: '2026-10-03T12:00:06.000000000Z',
    service: 'demo-payments',
    summary: `summary for ${id.slice(0, 8)}`,
    reliability: 'high',
  }));

const completed = (doc: Record<string, any> = SAMPLE): DiagnosisPayload => ({ ...doc, state: 'completed' }) as DiagnosisPayload;

function abstainedDoc(): Record<string, any> {
  const doc = JSON.parse(JSON.stringify(SAMPLE));
  doc.status = 'abstained';
  doc.abstain = true;
  delete doc.primary_hypothesis;
  doc.supporting_claims = [];
  doc.alternative_hypotheses = [];
  doc.missing_evidence = ['Failing traces for the deployment window', 'A deployment record for the incident'];
  doc.confidence = { value: 'low', explanation: 'There is too little evidence for a conclusion.' };
  doc.remediation_recommendation = { ...doc.remediation_recommendation, action_type: 'investigate', parameters: {} };
  return doc;
}

const render = (diagnosis: DiagnosisPayload | null, items: EvidenceItem[] = evidence()) =>
  renderToStaticMarkup(<DiagnosisCard incidentId={INCIDENT_ID} diagnosis={diagnosis} evidence={items} />);

// What React writes for a text node: the five HTML-significant characters become entities.
const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const count = (markup: string, needle: string) => markup.split(needle).length - 1;
const section = (markup: string, start: string, end: string) => {
  const from = markup.indexOf(start);
  assert.ok(from >= 0, `${start} is missing`);
  const to = markup.indexOf(end, from);
  return markup.slice(from, to < 0 ? undefined : to);
};

// ---- the five states ----

test('a null diagnosis is pending, with a plain GET Refresh form to the same page', () => {
  const markup = render(null);
  assert.ok(markup.includes('Diagnosis pending.'));
  assert.ok(markup.includes('The diagnosis agent runs every few seconds.'));
  const form = /<form [^>]*>/.exec(markup)?.[0] ?? '';
  assert.ok(form.includes('method="get"'), form);
  assert.ok(form.includes(`action="/incidents/${INCIDENT_ID}"`), form);
  assert.match(markup, /<button type="submit"[^>]*>Refresh<\/button>/);
});

test('a completed diagnosis shows the likely cause, confidence, claims, reasoning, alternatives, and provenance', () => {
  const markup = render(completed());
  assert.ok(markup.includes('Likely cause'));
  assert.ok(markup.includes(esc(SAMPLE.primary_hypothesis)));
  assert.ok(markup.includes(esc(SAMPLE.confidence.explanation)));
  for (const claim of SAMPLE.supporting_claims) assert.ok(markup.includes(esc(claim.claim)), claim.kind);
  assert.ok(markup.includes('Why'));
  assert.ok(markup.includes(esc(SAMPLE.reasoning_summary)));
  assert.ok(markup.includes('Alternatives considered'));
  for (const alt of SAMPLE.alternative_hypotheses) assert.ok(markup.includes(esc(alt.hypothesis)));
  assert.ok(!markup.includes('Diagnosis pending.'));
});

test('an abstained diagnosis says so, lists what is missing, and keeps reasoning and provenance', () => {
  const doc = abstainedDoc();
  const markup = render({ ...doc, state: 'abstained' } as DiagnosisPayload);
  assert.ok(markup.includes('No diagnosis: insufficient evidence.'));
  for (const missing of doc.missing_evidence) assert.ok(markup.includes(missing));
  assert.ok(markup.includes(doc.reasoning_summary));
  assert.ok(markup.includes(doc.provider.model));
  assert.ok(!markup.includes('Likely cause'), 'an abstention never invents a cause');
  assert.ok(!markup.includes('class="chip"'), 'an abstention cites nothing');
});

test('a failed diagnosis shows only the failure sentence with its code', () => {
  const markup = render({ state: 'failed', diagnosis_version: 2, failure_code: 'validation_rejected', created_at: '2026-10-07T21:49:41.208Z' });
  assert.ok(
    markup.includes('Diagnosis failed (validation_rejected). No automated diagnosis is available for this incident.'),
  );
  assert.ok(!markup.includes('Likely cause'));
});

test('an unavailable diagnosis says it could not be displayed', () => {
  const markup = render({ state: 'unavailable' });
  assert.ok(markup.includes('The diagnosis could not be displayed.'));
  assert.ok(!markup.includes('Likely cause'));
});

// ---- citations ----

test('every claim and alternative cites chips that link to exactly #evidence-<uuid>', () => {
  const markup = render(completed());
  const hrefs = [...markup.matchAll(/<a [^>]*class="chip"[^>]*>/g)].map((m) => /href="([^"]*)"/.exec(m[0])?.[1]);
  const expected = [
    ...SAMPLE.supporting_claims.flatMap((c: any) => c.evidence_ids),
    ...SAMPLE.alternative_hypotheses.flatMap((a: any) => a.disconfirming_evidence_ids),
  ].map((id: string) => `#evidence-${id}`);
  assert.deepEqual(hrefs, expected);
  for (const href of hrefs) assert.match(href ?? '', /^#evidence-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('a chip shows the evidence type and the first eight ID characters, and titles the full ID and summary', () => {
  const markup = render(completed());
  const chip = new RegExp(`<a [^>]*href="#evidence-${DEPLOYMENT_EVIDENCE}"[^>]*>([^<]*)</a>`).exec(markup);
  assert.ok(chip, 'the deployment chip must render');
  assert.equal(chip[1], `deployment ${DEPLOYMENT_EVIDENCE.slice(0, 8)}`);
  assert.ok(chip[0].includes(`title="${DEPLOYMENT_EVIDENCE}`), 'the title starts with the full ID');
  assert.ok(chip[0].includes(`summary for ${DEPLOYMENT_EVIDENCE.slice(0, 8)}`), 'the title includes the summary');
  const trace = new RegExp(`href="#evidence-${CITED[1]}"[^>]*>trace ${CITED[1].slice(0, 8)}</a>`);
  assert.match(markup, trace);
});

test('a citation with no matching evidence in the response is not linked', () => {
  const markup = render(completed(), evidence().slice(1));
  assert.ok(!markup.includes(`href="#evidence-${DEPLOYMENT_EVIDENCE}"`));
});

// ---- hostile text ----

test('hostile text from the stored document is escaped text, never an element or attribute', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const doc = JSON.parse(JSON.stringify(SAMPLE));
  doc.primary_hypothesis = hostile;
  doc.supporting_claims[0].claim = hostile;
  doc.confidence.explanation = hostile;
  doc.reasoning_summary = hostile;
  doc.alternative_hypotheses[0].hypothesis = hostile;
  doc.remediation_recommendation.summary = hostile;
  doc.remediation_recommendation.rollback_note = hostile;
  doc.provider.model = hostile;
  const items = evidence().map((item) => ({ ...item, summary: `${hostile}" onmouseover="alert(1)` }));
  const markup = render(completed(doc), items);
  assert.ok(!markup.includes('<img'), 'no element may be created from stored text');
  assert.ok(!/ onerror=|\sonmouseover=/.test(markup.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '').replace(/&quot; onmouseover=&quot;/g, '')));
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(markup.includes('&quot; onmouseover=&quot;alert(1)'), 'quotes in a title are escaped');

  const abstained = abstainedDoc();
  abstained.missing_evidence = [hostile];
  const second = render({ ...abstained, state: 'abstained' } as DiagnosisPayload);
  assert.ok(!second.includes('<img'));
  assert.ok(second.includes('&lt;img'));
});

test('markup in a failure code is escaped as text', () => {
  const markup = render({ state: 'failed', diagnosis_version: 1, failure_code: '<b>x</b>', created_at: '2026-10-07T21:49:41.208Z' });
  assert.ok(!markup.includes('<b>x'));
});

// ---- confidence and accessibility ----

test('confidence is a decorative dot plus a visible word, for every level', () => {
  for (const level of ['high', 'medium', 'low']) {
    const doc = JSON.parse(JSON.stringify(SAMPLE));
    doc.confidence.value = level;
    const markup = render(completed(doc));
    const confidence = section(markup, 'class="confidence"', '</div>');
    assert.match(confidence, new RegExp(`data-confidence="${level}"`));
    assert.match(confidence, /<span class="dot" aria-hidden="true"><\/span>/);
    assert.ok(confidence.includes(`>${level}<`) || confidence.includes(`</span>${level}<`), `the word ${level} must be visible`);
  }
});

// ---- recommendation ----

test('the recommendation panel carries the exact notice and nothing interactive', () => {
  const markup = render(completed());
  const panel = section(markup, 'class="recommendation"', '</aside>');
  assert.ok(panel.includes('Recommendation only. Nothing was executed. Approval arrives in a later slice.'));
  assert.ok(panel.includes(esc(SAMPLE.remediation_recommendation.summary)));
  for (const forbidden of ['<button', '<form', '<a', '<input', '<select']) {
    assert.ok(!panel.includes(forbidden), `the panel must not contain ${forbidden}`);
  }
});

// ---- provenance ----

test('provenance shows provider, model, prompt version, ID, version, time, and a shortened digest', () => {
  const markup = render(completed());
  const provenance = section(markup, 'class="provenance"', '</dl>');
  for (const value of [
    SAMPLE.provider.name,
    SAMPLE.model_version,
    SAMPLE.prompt_version,
    SAMPLE.diagnosis_id,
    String(SAMPLE.diagnosis_version),
    SAMPLE.created_at,
  ]) {
    assert.ok(provenance.includes(value), `provenance is missing ${value}`);
  }
  const hex = SAMPLE.input_digest.slice('sha256:'.length);
  assert.ok(provenance.includes(`sha256:${hex.slice(0, 12)}`));
  assert.ok(provenance.includes(`>sha256:${hex.slice(0, 12)}…<`), 'the digest is shortened in the text');
  assert.ok(provenance.includes(`title="${SAMPLE.input_digest}"`), 'the full digest is in the title');
});

test('the card adds no script, image, or external asset', () => {
  const markup = render(completed());
  assert.ok(!/<script|<img|<link|<iframe|https?:\/\//i.test(markup));
});

// ---- the detail page ----

const noRepo = (overrides: Partial<ClickHouseReader>): ClickHouseReader => {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected repository call');
  };
  return {
    listIncidents: unexpected,
    getIncident: unexpected,
    listEvidence: unexpected,
    getDeployment: unexpected,
    listDeployments: unexpected,
    failingTraces: unexpected,
    incidentLinks: unexpected,
    latestDiagnosis: async () => null,
    latestDiagnoses: async () => [],
    ...overrides,
  };
};

async function renderPage(withDiagnosis: boolean): Promise<string> {
  installDashboardService(
    createDashboardService({
      now: () => new Date('2026-10-07T22:00:00.000Z'),
      repo: noRepo({
        getIncident: async () => ({
          incident_id: INCIDENT_ID,
          revision: '1',
          title: 'Payments 5xx burst',
          status: 'open',
          severity: 'high',
          service: 'demo-payments',
          environment: 'local',
          deployment_id: '57d9bf44-46c0-46e9-8140-4a7b9f3694a8',
          trigger_rule: 'payments-5xx-burst-after-deployment',
          started_at: '2026-10-03 12:00:05.123000000',
          detected_at: '2026-10-03 12:00:12.456000000',
          publication_state: 'published',
          published_at: '2026-10-03 12:00:13.001000000',
        }),
        getDeployment: async () => null,
        listEvidence: async () =>
          evidence().map((item) => ({ ...item, timestamp: '2026-10-03 12:00:06.000000000' })),
        latestDiagnosis: async () =>
          withDiagnosis
            ? {
                diagnosis_version: 1,
                status: 'completed',
                confidence: 'high',
                failure_code: '',
                document: JSON.stringify(SAMPLE),
                created_at: '2026-10-07 21:49:41.208',
              }
            : null,
      }),
    }),
  );
  try {
    return renderToStaticMarkup(await IncidentDetailPage({ params: Promise.resolve({ incidentId: INCIDENT_ID }) }));
  } finally {
    installDashboardService(undefined);
  }
}

test('the page puts Diagnosis under the explanation and above Deployment', async () => {
  const markup = await renderPage(true);
  const explanation = markup.indexOf('class="explanation"');
  const diagnosis = markup.indexOf('>Diagnosis</h2>');
  const deployment = markup.indexOf('>Deployment</h2>');
  assert.ok(explanation >= 0 && diagnosis > explanation && deployment > diagnosis, `${explanation} ${diagnosis} ${deployment}`);
  assert.equal(count(markup, '>Diagnosis</h2>'), 1);
  assert.ok(markup.includes(esc(SAMPLE.primary_hypothesis)));
});

test('the page shows the pending state when there is no diagnosis', async () => {
  const markup = await renderPage(false);
  assert.ok(markup.includes('Diagnosis pending.'));
});

test('every evidence table row has id="evidence-<uuid>", and every chip target exists', async () => {
  const markup = await renderPage(true);
  for (const id of CITED) assert.equal(count(markup, `<tr id="evidence-${id}"`), 1, id);
  for (const [, target] of markup.matchAll(/class="chip"[^>]*href="#([^"]+)"|href="#([^"]+)"[^>]*class="chip"/g)) {
    if (target) assert.ok(markup.includes(`id="${target}"`));
  }
  for (const [, href] of markup.matchAll(/<a [^>]*class="chip"[^>]*href="#([^"]+)"/g)) {
    assert.ok(markup.includes(`id="${href}"`), `${href} has no target row`);
  }
});

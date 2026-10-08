// The Diagnosis section of the incident page, from docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 9.4.
// A server component with no client state. Every diagnosis string is rendered as React text, so markup in a stored
// document is shown as characters and never becomes an element. Citation chips link only to #evidence-<uuid> for an
// ID that is both a well-formed UUID and present in the evidence this page shows.
import type { DiagnosisPayload } from '../server/diagnosis';
import type { EvidenceItem } from '../server/model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_EXECUTED = 'Recommendation only. Nothing was executed. Approval arrives in a later slice.';

// The parts of a validated document this card reads. The server has already checked all of them.
interface Claim {
  kind: string;
  claim: string;
  evidence_ids: string[];
}
interface Alternative {
  hypothesis: string;
  disconfirming_evidence_ids: string[];
}
interface Recommendation {
  action_type: string;
  summary: string;
  risk: string;
  expected_effect: string;
  rollback_note: string;
}
interface Document {
  diagnosis_id: string;
  diagnosis_version: number;
  primary_hypothesis?: string;
  supporting_claims: Claim[];
  alternative_hypotheses: Alternative[];
  confidence: { value: string; explanation: string };
  missing_evidence: string[];
  reasoning_summary: string;
  remediation_recommendation: Recommendation;
  provider: { name: string; model: string; fallback_from: string | null };
  model_version: string;
  prompt_version: string;
  input_digest: string;
  created_at: string;
}

function Chips({ ids, evidence }: { ids: string[]; evidence: Map<string, EvidenceItem> }) {
  return (
    <span className="chips">
      {ids.map((id) => {
        const item = evidence.get(id);
        if (item === undefined || !UUID.test(id)) return null;
        return (
          <a key={id} className="chip" href={`#evidence-${id}`} title={`${id} — ${item.summary}`}>
            {`${item.source_type} ${id.slice(0, 8)}`}
          </a>
        );
      })}
    </span>
  );
}

function Provenance({ doc }: { doc: Document }) {
  const provider = doc.provider.fallback_from === null ? doc.provider.name : `${doc.provider.name} (fallback from ${doc.provider.fallback_from})`;
  const hex = doc.input_digest.replace(/^sha256:/, '');
  return (
    <dl className="provenance">
      <dt>Provider</dt>
      <dd>{provider}</dd>
      <dt>Model</dt>
      <dd className="mono">{doc.model_version}</dd>
      <dt>Prompt</dt>
      <dd className="mono">{doc.prompt_version}</dd>
      <dt>Diagnosis ID</dt>
      <dd className="mono">{doc.diagnosis_id}</dd>
      <dt>Version</dt>
      <dd>{String(doc.diagnosis_version)}</dd>
      <dt>Created (UTC)</dt>
      <dd>
        <time className="mono" dateTime={doc.created_at}>
          {doc.created_at}
        </time>
      </dd>
      <dt>Input digest</dt>
      <dd className="mono" title={doc.input_digest}>{`sha256:${hex.slice(0, 12)}…`}</dd>
    </dl>
  );
}

function Recommendation({ recommendation }: { recommendation: Recommendation }) {
  return (
    <aside className="recommendation">
      <h3>Recommendation</h3>
      <p className="recommendation-notice">{NOT_EXECUTED}</p>
      <p>{recommendation.summary}</p>
      <dl>
        <dt>Action</dt>
        <dd className="mono">{recommendation.action_type}</dd>
        <dt>Risk</dt>
        <dd>{recommendation.risk}</dd>
        <dt>Expected effect</dt>
        <dd>{recommendation.expected_effect}</dd>
        <dt>Rollback</dt>
        <dd>{recommendation.rollback_note}</dd>
      </dl>
    </aside>
  );
}

function Completed({ doc, evidence }: { doc: Document; evidence: Map<string, EvidenceItem> }) {
  return (
    <>
      <p className="cause-label">Likely cause</p>
      <p className="cause">{doc.primary_hypothesis}</p>
      <div className="confidence">
        <span className="status" data-confidence={doc.confidence.value}>
          <span className="dot" aria-hidden="true"></span>
          {doc.confidence.value}
        </span>
        <span className="confidence-explanation">{doc.confidence.explanation}</span>
      </div>

      <h3>Why</h3>
      <ol className="claims">
        {doc.supporting_claims.map((claim, index) => (
          <li key={index}>
            <span>{claim.claim}</span>
            <Chips ids={claim.evidence_ids} evidence={evidence} />
          </li>
        ))}
      </ol>

      <h3>Reasoning</h3>
      <p>{doc.reasoning_summary}</p>

      {doc.alternative_hypotheses.length > 0 ? (
        <>
          <h3>Alternatives considered</h3>
          <ul className="alternatives">
            {doc.alternative_hypotheses.map((alternative, index) => (
              <li key={index}>
                <span>{alternative.hypothesis}</span>
                <span className="argued-against">Argued against by</span>
                <Chips ids={alternative.disconfirming_evidence_ids} evidence={evidence} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {doc.missing_evidence.length > 0 ? <MissingEvidence items={doc.missing_evidence} /> : null}
      <Recommendation recommendation={doc.remediation_recommendation} />
      <Provenance doc={doc} />
    </>
  );
}

function MissingEvidence({ items }: { items: string[] }) {
  return (
    <>
      <h3>Missing evidence</h3>
      <ul className="missing">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </>
  );
}

function Abstained({ doc }: { doc: Document }) {
  return (
    <>
      <p className="cause">No diagnosis: insufficient evidence.</p>
      <MissingEvidence items={doc.missing_evidence} />
      <h3>Reasoning</h3>
      <p>{doc.reasoning_summary}</p>
      <Provenance doc={doc} />
    </>
  );
}

function Body({ incidentId, diagnosis, evidence }: { incidentId: string; diagnosis: DiagnosisPayload | null; evidence: Map<string, EvidenceItem> }) {
  if (diagnosis === null) {
    return (
      <>
        <p className="cause">Diagnosis pending.</p>
        <p className="muted">The diagnosis agent runs every few seconds.</p>
        <form method="get" action={`/incidents/${incidentId}`}>
          <button type="submit">Refresh</button>
        </form>
      </>
    );
  }
  if (diagnosis.state === 'completed') return <Completed doc={diagnosis as unknown as Document} evidence={evidence} />;
  if (diagnosis.state === 'abstained') return <Abstained doc={diagnosis as unknown as Document} />;
  if (diagnosis.state === 'failed') {
    return <p className="cause">{`Diagnosis failed (${diagnosis.failure_code}). No automated diagnosis is available for this incident.`}</p>;
  }
  return <p className="cause">The diagnosis could not be displayed.</p>;
}

export function DiagnosisCard({
  incidentId,
  diagnosis,
  evidence,
}: {
  incidentId: string;
  diagnosis: DiagnosisPayload | null;
  evidence: EvidenceItem[];
}) {
  const byId = new Map(evidence.map((item) => [item.evidence_id, item]));
  return (
    <section className="diagnosis" aria-labelledby="diagnosis-heading">
      <h2 id="diagnosis-heading">Diagnosis</h2>
      <div className="diagnosis-body">
        <Body incidentId={incidentId} diagnosis={diagnosis} evidence={byId} />
      </div>
    </section>
  );
}

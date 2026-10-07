import { notFound } from 'next/navigation';
import { EvidenceTimeline } from '../../../src/ui/evidence-timeline';
import { Shell } from '../../../src/ui/shell';
import { ClickHouseUnavailable } from '../../../src/server/clickhouse';
import { getDashboardService, IncidentNotFound } from '../../../src/server/service';
import { InvalidInput } from '../../../src/server/validate';

// Reads ClickHouse on every request.
export const dynamic = 'force-dynamic';

type Detail = Awaited<ReturnType<ReturnType<typeof getDashboardService>['getIncidentDetail']>>;

// Calls the service directly, not the /api routes. An unknown or malformed ID is a 404. An unavailable store
// returns null, so the page can show the fixed message. Only the error class is logged.
async function load(incidentId: string): Promise<Detail | null> {
  try {
    return await getDashboardService().getIncidentDetail(incidentId);
  } catch (error) {
    if (error instanceof IncidentNotFound || error instanceof InvalidInput) notFound();
    const kind = error instanceof ClickHouseUnavailable ? 'ClickHouseUnavailable' : 'unexpected';
    console.error(JSON.stringify({ level: 'error', message: 'incident detail unavailable', error: kind }));
    return null;
  }
}

export default async function IncidentDetailPage({ params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  const detail = await load(incidentId);

  if (detail === null) {
    return (
      <Shell current="incidents">
        <div className="notice">
          <p>ClickHouse is unavailable.</p>
          <p>
            <a href="/incidents">Back to incidents</a>
          </p>
        </div>
      </Shell>
    );
  }

  const { incident, explanation, deployment, evidence } = detail;
  return (
    <Shell current="incidents">
      <section className="detail">
        <p className="crumb">
          <a href="/incidents">Incidents</a>
        </p>
        <h1>{incident.title}</h1>
        <p className="summary">
          {`${incident.severity} severity, ${incident.status}, ${incident.publication_state}, detected `}
          <time className="mono" dateTime={incident.detected_at}>
            {incident.detected_at}
          </time>
        </p>

        <p className="explanation">{explanation}</p>

        <h2>Deployment</h2>
        {deployment === null ? (
          <p className="notice">{`No deployment record was found for ${incident.deployment_id}.`}</p>
        ) : (
          <dl className="panel">
            <dt>Version</dt>
            <dd className="mono">{deployment.new_version}</dd>
            <dt>Environment</dt>
            <dd>{deployment.environment}</dd>
            <dt>Deployment ID</dt>
            <dd className="mono">{deployment.deployment_id}</dd>
            <dt>Deployed</dt>
            <dd>
              <time className="mono" dateTime={deployment.timestamp}>
                {deployment.timestamp}
              </time>
            </dd>
            <dt>Status</dt>
            <dd>{deployment.status}</dd>
            <dt>Initiated by</dt>
            <dd>{deployment.initiated_by}</dd>
          </dl>
        )}
        <p>
          <a href={`/deployments#deployment-${incident.deployment_id}`}>View on the deployment timeline</a>
        </p>

        <h2>Evidence timeline</h2>
        <EvidenceTimeline items={evidence} />

        <h2>Evidence</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Source type</th>
                <th scope="col">Source reference</th>
                <th scope="col">Timestamp (UTC)</th>
                <th scope="col">Summary</th>
                <th scope="col">Reliability</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((row) => (
                <tr key={row.evidence_id}>
                  <td>{row.source_type}</td>
                  <td className="mono">{row.source_ref}</td>
                  <td className="mono">{row.timestamp}</td>
                  <td>{row.summary}</td>
                  <td>{row.reliability}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}

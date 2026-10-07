// The deployment timeline and its table. It renders one of four explicit states from props. It is a server
// component: hand-built SVG, no charting library, no client state. Timestamps are shown as the API's UTC text,
// never converted with Date. Markers run oldest to newest, evenly spaced, because deployments can be hours apart
// and true spacing would crowd the recent ones together.
import type { DeploymentItem } from '../server/model';
import { classifyDeployment } from '../server/model';

export type DeployTimelineState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error' }
  | { kind: 'loaded'; deployments: DeploymentItem[] };

// docs/specs/2026-10-06-incident-dashboard.md, section 5.3.
export const FOOTNOTE = '"No failures observed" is deliberately not "healthy". A deployment with no traffic is not proven healthy.';

const PAD = 110;
const GAP = 170;
const INCIDENT_Y = 34;
const AXIS_Y = 100;
const HEIGHT = 200;

function labelOf(deployment: DeploymentItem): string {
  return classifyDeployment({
    status: deployment.status,
    failingTraces: deployment.failing_traces,
    incidentCount: deployment.incident_ids.length,
  }).label;
}

// Oldest first. UTC text of fixed width sorts correctly as a string; the ID breaks ties.
function oldestFirst(deployments: DeploymentItem[]): DeploymentItem[] {
  return [...deployments].sort((a, b) =>
    a.timestamp !== b.timestamp
      ? a.timestamp < b.timestamp ? -1 : 1
      : a.deployment_id < b.deployment_id ? -1 : a.deployment_id > b.deployment_id ? 1 : 0,
  );
}

function Shape({ deployment, x }: { deployment: DeploymentItem; x: number }) {
  if (deployment.class === 'faulty') {
    const points = `${x},${AXIS_Y - 9} ${x + 9},${AXIS_Y + 7} ${x - 9},${AXIS_Y + 7}`;
    return <polygon points={points} className="marker-faulty" />;
  }
  if (deployment.class === 'healthy') {
    return <circle cx={x} cy={AXIS_Y} r={7} className="marker-healthy" />;
  }
  return <circle cx={x} cy={AXIS_Y} r={6} className="marker-unknown" />;
}

function Marker({ deployment, x, index }: { deployment: DeploymentItem; x: number; index: number }) {
  const incident = deployment.incident_ids[0];
  // Timestamps alternate between two rows so neighbors never overlap.
  const timeY = AXIS_Y + 58 + (index % 2) * 16;
  return (
    <g
      id={`deployment-${deployment.deployment_id}`}
      data-marker="deployment"
      data-deployment={deployment.deployment_id}
      data-class={deployment.class}
      data-x={x}
    >
      <title>{deployment.deployment_id}</title>
      {incident ? (
        <>
          <line x1={x} x2={x} y1={INCIDENT_Y + 8} y2={AXIS_Y - 9} className="timeline-connector" />
          <a href={`/incidents/${incident}`}>
            <polygon
              points={`${x},${INCIDENT_Y - 8} ${x + 8},${INCIDENT_Y} ${x},${INCIDENT_Y + 8} ${x - 8},${INCIDENT_Y}`}
              className="marker-incident"
            />
            <text x={x} y={INCIDENT_Y - 14} textAnchor="middle" className="timeline-link mono">
              {`incident ${incident.slice(0, 8)}…`}
            </text>
          </a>
        </>
      ) : null}
      <Shape deployment={deployment} x={x} />
      <text x={x} y={AXIS_Y + 26} textAnchor="middle" className="timeline-label mono">
        {deployment.new_version}
      </text>
      <text
        x={x}
        y={AXIS_Y + 42}
        textAnchor="middle"
        className={deployment.class === 'faulty' ? 'timeline-status timeline-status-faulty' : 'timeline-status'}
      >
        {deployment.class === 'unknown' ? deployment.status : labelOf(deployment)}
      </text>
      <text x={x} y={timeY} textAnchor="middle" className="timeline-time mono">
        {deployment.timestamp}
      </text>
    </g>
  );
}

function Timeline({ deployments }: { deployments: DeploymentItem[] }) {
  const sorted = oldestFirst(deployments);
  const width = Math.max(800, PAD * 2 + (sorted.length - 1) * GAP);
  const x = (index: number) => PAD + index * GAP;
  return (
    <div className="timeline">
      <div className="timeline-scroll">
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-labelledby="deploy-timeline-title">
          <title id="deploy-timeline-title">Payments deployments in UTC order, oldest on the left</title>
          <line x1={PAD - 50} x2={width - PAD + 50} y1={AXIS_Y} y2={AXIS_Y} className="timeline-axis" />
          {sorted.map((deployment, index) => (
            <Marker key={deployment.deployment_id} deployment={deployment} x={x(index)} index={index} />
          ))}
        </svg>
      </div>
      <p className="timeline-note">Markers are in UTC order and evenly spaced, not to scale. Read times from the labels.</p>
    </div>
  );
}

function Table({ rows }: { rows: DeploymentItem[] }) {
  return (
    <>
      {rows.map((deployment) => (
        <tr key={deployment.deployment_id} id={`row-${deployment.deployment_id}`}>
          <td>
            <time className="mono" dateTime={deployment.timestamp}>
              {deployment.timestamp}
            </time>
          </td>
          <td className="mono">{deployment.new_version}</td>
          <td>
            <span className="status" data-class={deployment.class}>
              <span className="dot" aria-hidden="true"></span>
              {deployment.class === 'unknown' ? deployment.status : labelOf(deployment)}
            </span>
          </td>
          <td className={deployment.failing_traces > 0 ? 'count-faulty' : undefined}>{deployment.failing_traces}</td>
          <td>
            {deployment.incident_ids.length === 0
              ? '—'
              : deployment.incident_ids.map((id) => (
                  <a key={id} className="mono" href={`/incidents/${id}`}>
                    {`${id.slice(0, 8)}…`}
                  </a>
                ))}
          </td>
        </tr>
      ))}
    </>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((row) => (
        <tr key={row} data-skeleton-row="" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((cell) => (
            <td key={cell}>
              <span className="skeleton" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function DeployTimeline({ state }: { state: DeployTimelineState }) {
  const loaded = state.kind === 'loaded';
  return (
    <section>
      <div className="page-header">
        <h1>Deployments</h1>
        {loaded ? <span className="count">{`${state.deployments.length} loaded`}</span> : null}
        <form method="get" action="/deployments">
          <button type="submit">Refresh</button>
        </form>
      </div>

      {state.kind === 'empty' ? (
        <div className="notice">
          <p>No Payments deployments recorded yet.</p>
          <p>
            Run the <a href="/demo">demo flow</a> to create one.
          </p>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className="notice">
          <p>ClickHouse is unavailable.</p>
        </div>
      ) : null}

      {state.kind === 'loaded' ? <Timeline deployments={state.deployments} /> : null}

      {state.kind === 'loading' || state.kind === 'loaded' ? (
        <div className="table-wrap" aria-busy={state.kind === 'loading' ? 'true' : undefined}>
          <table>
            <thead>
              <tr>
                <th scope="col">Deployed (UTC)</th>
                <th scope="col">Version</th>
                <th scope="col">Class</th>
                <th scope="col">Failing traces</th>
                <th scope="col">Incident</th>
              </tr>
            </thead>
            <tbody>{state.kind === 'loading' ? <SkeletonRows /> : <Table rows={state.deployments} />}</tbody>
          </table>
        </div>
      ) : null}

      {loaded ? <p className="footnote">{FOOTNOTE}</p> : null}
    </section>
  );
}

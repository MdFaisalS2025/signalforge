// The deployment timeline and its table. It renders one of four explicit states from props. It is a server
// component: hand-built SVG, no charting library, no client state. Timestamps are shown as the API's UTC text,
// never rewritten. Markers run oldest to newest and are placed in proportion to UTC time, from the earliest to the
// latest deployment. The timestamps are parsed to exact integer nanoseconds only to compute that placement.
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

const API_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/;
const TIE_STEP = 24; // markers at the same instant are offset by this much, so none hides another

// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm), in whole-number arithmetic.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Exact nanoseconds since the epoch. Used for placement only; the displayed text is the original string.
function epochNanos(iso: string): bigint {
  const match = API_TIMESTAMP.exec(iso);
  if (!match) throw new TypeError('unexpected API timestamp format');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const seconds = BigInt(daysFromCivil(year, month, day)) * 86400n + BigInt(hour * 3600 + minute * 60 + second);
  return seconds * 1_000_000_000n + BigInt(match[7]);
}

// Positions for deployments already sorted oldest first. The first sits at PAD and the last at width - PAD, with the
// rest in proportion to time. A tie with the previous marker is offset by TIE_STEP. If every deployment shares one
// instant there is no time span to scale, so they are spread by GAP in the same deterministic order.
function place(sorted: DeploymentItem[], width: number): number[] {
  if (sorted.length === 1) return [width / 2];
  const times = sorted.map((deployment) => epochNanos(deployment.timestamp));
  const span = times[times.length - 1] - times[0];
  if (span === 0n) return sorted.map((_, index) => PAD + index * GAP);
  const available = width - 2 * PAD;
  return times.map((time, index) => {
    const proportional = PAD + Number(((time - times[0]) * BigInt(available * 10)) / span) / 10;
    return index > 0 && time === times[index - 1] ? Math.round((proportional + TIE_STEP * tieRun(times, index)) * 10) / 10 : Math.round(proportional * 10) / 10;
  });
}

// How many markers directly before index share its instant.
function tieRun(times: bigint[], index: number): number {
  let run = 0;
  while (index - run - 1 >= 0 && times[index - run - 1] === times[index]) run += 1;
  return run;
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
  const positions = place(sorted, width);
  const x = (index: number) => positions[index];
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

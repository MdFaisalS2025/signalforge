'use client';

// The incident list. It renders one of four explicit states from props, so each state is testable on its own.
// The only client-side work is setting the detected-time title to the viewer's local time. It stores no state.
import { useEffect, useRef } from 'react';
import type { IncidentItem } from '../server/model';

export type IncidentListState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error' }
  | { kind: 'loaded'; incidents: IncidentItem[] };

// Refresh is a plain GET form, so it works without JavaScript and keeps no client state.
function RefreshForm() {
  return (
    <form method="get" action="/incidents">
      <button type="submit">Refresh</button>
    </form>
  );
}

// The server renders the exact UTC text as the title. After hydration, the title shows the viewer's local time and
// keeps the full UTC text, so no precision is lost in the tooltip.
function UtcTime({ iso }: { iso: string }) {
  const ref = useRef<HTMLTimeElement>(null);
  useEffect(() => {
    if (ref.current === null) return;
    const local = new Date(iso).toLocaleString();
    ref.current.title = `Local ${local} (UTC ${iso})`;
  }, [iso]);
  return (
    <time ref={ref} dateTime={iso} title={`UTC ${iso}`} className="mono">
      {iso}
    </time>
  );
}

function StatusDot({ word, attribute, value, title }: { word: string; attribute: string; value: string; title?: string }) {
  return (
    <span className="status" title={title} {...{ [attribute]: value }}>
      <span className="dot" aria-hidden="true"></span>
      {word}
    </span>
  );
}

function LoadedRows({ incidents }: { incidents: IncidentItem[] }) {
  return (
    <>
      {incidents.map((incident) => (
        <tr key={incident.incident_id}>
          <td>
            <a className="mono" href={`/incidents/${incident.incident_id}`}>
              {incident.incident_id}
            </a>
          </td>
          <td>
            <StatusDot word={incident.severity} attribute="data-severity" value={incident.severity} />
          </td>
          <td>{incident.status}</td>
          <td className="mono">{incident.service}</td>
          <td className="mono">
            {incident.deployment_version ?? (
              <span title="No matching deployment in the store">—</span>
            )}
          </td>
          <td>
            <UtcTime iso={incident.detected_at} />
          </td>
          <td>
            <StatusDot
              word={incident.publication_state}
              attribute="data-publication"
              value={incident.publication_state}
              title={incident.published_at === null ? undefined : `Published at ${incident.published_at}`}
            />
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
          {[0, 1, 2, 3, 4, 5, 6].map((cell) => (
            <td key={cell}>
              <span className="skeleton" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function Body({ state }: { state: IncidentListState }) {
  if (state.kind === 'loading') {
    return <SkeletonRows />;
  }
  if (state.kind === 'loaded') {
    return <LoadedRows incidents={state.incidents} />;
  }
  return null;
}

export function IncidentList({ state }: { state: IncidentListState }) {
  const loaded = state.kind === 'loaded';
  return (
    <section>
      <div className="page-header">
        <h1>Incidents</h1>
        {loaded ? <span className="count">{`${state.incidents.length} loaded`}</span> : null}
        <RefreshForm />
      </div>

      {state.kind === 'empty' ? (
        <div className="notice">
          <p>No incidents yet.</p>
          <p>
            Run the <a href="/demo">demo flow</a> (section 10) to create one.
          </p>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className="notice">
          <p>ClickHouse is unavailable.</p>
        </div>
      ) : null}

      {state.kind === 'loading' || state.kind === 'loaded' ? (
        <div className="table-wrap" aria-busy={state.kind === 'loading' ? 'true' : undefined}>
          <table>
            <thead>
              <tr>
                <th scope="col">Incident</th>
                <th scope="col">Severity</th>
                <th scope="col">Status</th>
                <th scope="col">Service</th>
                <th scope="col">Version</th>
                <th scope="col">Detected (UTC)</th>
                <th scope="col">Publication</th>
              </tr>
            </thead>
            <tbody>
              <Body state={state} />
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

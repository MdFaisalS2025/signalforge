import { IncidentList, type IncidentListState } from '../../src/ui/incident-list';
import { Shell } from '../../src/ui/shell';
import { ClickHouseUnavailable } from '../../src/server/clickhouse';
import { getDashboardService } from '../../src/server/service';

// Reads ClickHouse on every request. A static prerender would run at build time, without the environment.
export const dynamic = 'force-dynamic';

// Calls the service directly. It does not fetch the /api routes over HTTP.
async function loadIncidents(): Promise<IncidentListState> {
  try {
    const { incidents } = await getDashboardService().listIncidents(undefined);
    return incidents.length === 0 ? { kind: 'empty' } : { kind: 'loaded', incidents };
  } catch (error) {
    // The page shows a fixed message. Only the error class is logged, never SQL, driver text, or credentials.
    const kind = error instanceof ClickHouseUnavailable ? 'ClickHouseUnavailable' : 'unexpected';
    console.error(JSON.stringify({ level: 'error', message: 'incident list unavailable', error: kind }));
    return { kind: 'error' };
  }
}

export default async function IncidentsPage() {
  const state = await loadIncidents();
  return (
    <Shell current="incidents">
      <IncidentList state={state} />
    </Shell>
  );
}

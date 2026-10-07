import { DeployTimeline, type DeployTimelineState } from '../../src/ui/deploy-timeline';
import { Shell } from '../../src/ui/shell';
import { ClickHouseUnavailable } from '../../src/server/clickhouse';
import { getDashboardService } from '../../src/server/service';

// Reads ClickHouse on every request.
export const dynamic = 'force-dynamic';

// Calls the service directly. It does not fetch the /api routes over HTTP. The service returns the ten most recent
// Payments deployments by default.
async function loadDeployments(): Promise<DeployTimelineState> {
  try {
    const { deployments } = await getDashboardService().listDeployments(undefined);
    return deployments.length === 0 ? { kind: 'empty' } : { kind: 'loaded', deployments };
  } catch (error) {
    // The page shows a fixed message. Only the error class is logged, never SQL, driver text, or credentials.
    const kind = error instanceof ClickHouseUnavailable ? 'ClickHouseUnavailable' : 'unexpected';
    console.error(JSON.stringify({ level: 'error', message: 'deployment timeline unavailable', error: kind }));
    return { kind: 'error' };
  }
}

export default async function DeploymentsPage() {
  const state = await loadDeployments();
  return (
    <Shell current="deployments">
      <DeployTimeline state={state} />
    </Shell>
  );
}

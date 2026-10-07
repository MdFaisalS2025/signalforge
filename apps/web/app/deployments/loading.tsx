import { DeployTimeline } from '../../src/ui/deploy-timeline';
import { Shell } from '../../src/ui/shell';

// Shown while the server page loads. It is the same tested loading state as the timeline component.
export default function Loading() {
  return (
    <Shell current="deployments">
      <DeployTimeline state={{ kind: 'loading' }} />
    </Shell>
  );
}

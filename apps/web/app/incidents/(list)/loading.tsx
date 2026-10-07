import { IncidentList } from '../../../src/ui/incident-list';
import { Shell } from '../../../src/ui/shell';

// Shown while the server page loads. It is the same tested loading state as the list component.
export default function Loading() {
  return (
    <Shell current="incidents">
      <IncidentList state={{ kind: 'loading' }} />
    </Shell>
  );
}

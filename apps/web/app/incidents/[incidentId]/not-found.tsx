import { Shell } from '../../../src/ui/shell';

// Shown when an incident ID is unknown or malformed.
export default function IncidentNotFound() {
  return (
    <Shell current="incidents">
      <div className="notice">
        <p>Incident not found.</p>
        <p>
          <a href="/incidents">Back to incidents</a>
        </p>
      </div>
    </Shell>
  );
}

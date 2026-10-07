// A hand-built SVG timeline of an incident's evidence on a UTC axis. It is a server component with no client
// state and no charting library. Marker order and text come from the API strings. Positions are computed with
// integer arithmetic on the nanosecond text, never with Date, so no precision is lost or rounded.
import type { EvidenceItem } from '../server/model';

const EXPECTED_ITEMS = 4;
const PAD = 100; // room for centered labels at the first and last marker
const MIN_WIDTH = 800;
const MIN_GAP = 190; // wide enough that two 30-character timestamps never overlap
const AXIS_Y = 70;
const HEIGHT = 150;

const API_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/;

// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm), in whole-number arithmetic.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Nanoseconds since the epoch, exact, from "2026-10-03T12:00:00.000000000Z".
function epochNanos(iso: string): bigint {
  const match = API_TIMESTAMP.exec(iso);
  if (!match) throw new TypeError('unexpected API timestamp format');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const seconds = BigInt(daysFromCivil(year, month, day)) * 86400n + BigInt(hour * 3600 + minute * 60 + second);
  return seconds * 1_000_000_000n + BigInt(match[7]);
}

interface Placed {
  item: EvidenceItem;
  nanos: bigint;
  x: number;
}

// Chronological order, with a fixed tie-break (deployment first, then reference), so equal timestamps always
// place the same way regardless of input order.
function ordered(items: EvidenceItem[]): Array<{ item: EvidenceItem; nanos: bigint }> {
  return items
    .map((item) => ({ item, nanos: epochNanos(item.timestamp) }))
    .sort((a, b) => {
      if (a.nanos !== b.nanos) return a.nanos < b.nanos ? -1 : 1;
      if (a.item.source_type !== b.item.source_type) return a.item.source_type === 'deployment' ? -1 : 1;
      return a.item.source_ref < b.item.source_ref ? -1 : a.item.source_ref > b.item.source_ref ? 1 : 0;
    });
}

// Linear in time between the first and last marker, then widened so neighbors are at least MIN_GAP apart.
function place(sorted: Array<{ item: EvidenceItem; nanos: bigint }>): { placed: Placed[]; width: number; widened: boolean } {
  const span = sorted[sorted.length - 1].nanos - sorted[0].nanos;
  const provisional = MIN_WIDTH - 2 * PAD;
  let widened = false;
  const placed: Placed[] = [];
  for (const entry of sorted) {
    const linear =
      span === 0n ? PAD : PAD + Number(((entry.nanos - sorted[0].nanos) * BigInt(provisional)) / span);
    const previous = placed[placed.length - 1];
    const x = previous && linear < previous.x + MIN_GAP ? previous.x + MIN_GAP : linear;
    if (x !== linear) widened = true;
    placed.push({ ...entry, x: Math.round(x * 10) / 10 });
  }
  return { placed, width: Math.max(MIN_WIDTH, placed[placed.length - 1].x + PAD), widened };
}

function Marker({ entry }: { entry: Placed }) {
  const { item, x } = entry;
  const isDeployment = item.source_type === 'deployment';
  const label = isDeployment ? 'deployment' : `trace ${item.source_ref.slice(0, 12)}…`;
  return (
    <g data-marker={isDeployment ? 'deployment' : 'trace'} data-ref={item.source_ref} data-x={x}>
      <title>{item.source_ref}</title>
      <line x1={x} x2={x} y1={AXIS_Y - 14} y2={AXIS_Y} className="timeline-stem" />
      {isDeployment ? (
        <rect x={x - 7} y={AXIS_Y - 7} width={14} height={14} className="marker-deployment" />
      ) : (
        <circle cx={x} cy={AXIS_Y} r={7} className="marker-trace" />
      )}
      <text x={x} y={AXIS_Y - 22} textAnchor="middle" className="timeline-label mono">
        {label}
      </text>
      <text x={x} y={AXIS_Y + 28} textAnchor="middle" className="timeline-time mono">
        {item.timestamp}
      </text>
    </g>
  );
}

export function EvidenceTimeline({ items }: { items: EvidenceItem[] }) {
  const warning =
    items.length < EXPECTED_ITEMS ? (
      <p role="status" className="warning">
        {`Only ${items.length} of ${EXPECTED_ITEMS} expected evidence items are present.`}
      </p>
    ) : null;

  if (items.length === 0) return <div className="timeline">{warning}</div>;

  const { placed, width, widened } = place(ordered(items));
  const first = placed[0];
  const last = placed[placed.length - 1];

  return (
    <div className="timeline">
      {warning}
      <div className="timeline-scroll">
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-labelledby="timeline-title"
        >
          <title id="timeline-title">Evidence timeline on a UTC axis, deployment first, then failing traces</title>
          <line x1={PAD - 40} x2={width - PAD + 40} y1={AXIS_Y} y2={AXIS_Y} className="timeline-axis" />
          {placed.map((entry) => (
            <Marker key={`${entry.item.source_type}:${entry.item.source_ref}`} entry={entry} />
          ))}
          <text x={PAD - 40} y={HEIGHT - 12} className="timeline-axis-label mono" data-axis="start">
            {`start ${first.item.timestamp}`}
          </text>
          <text x={width - PAD + 40} y={HEIGHT - 12} textAnchor="end" className="timeline-axis-label mono" data-axis="end">
            {`end ${last.item.timestamp}`}
          </text>
        </svg>
      </div>
      {widened ? (
        <p className="timeline-note">Marker spacing is widened for legibility. Read times from the labels.</p>
      ) : null}
    </div>
  );
}

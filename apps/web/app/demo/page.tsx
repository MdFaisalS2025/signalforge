import { Shell } from '../../src/ui/shell';

// Static: no data, no service, no network. It works when ClickHouse is down. Each command sits in its own
// preformatted block, so it copies as plain text with no script. The commands are from
// docs/specs/2026-10-06-incident-dashboard.md, section 10.

const STEP_1 =
  'docker compose -f infra/docker/docker-compose.yml up -d --build redpanda redpanda-init clickhouse otel-collector collector-go demo-orders demo-payments web';
const STEP_2 = 'node scripts/deploy-payments.mjs --version 0.2.0-faulty --fault enabled';
const STEP_3 = [
  'curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\\"order_id\\":\\"11111111-1111-4111-8111-111111111111\\",\\"item\\":\\"demo-keyboard\\",\\"amount_cents\\":4999}"',
  'curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\\"order_id\\":\\"22222222-2222-4222-8222-222222222222\\",\\"item\\":\\"demo-mouse\\",\\"amount_cents\\":1999}"',
  'curl -s -X POST http://localhost:8081/orders -H "content-type: application/json" -d "{\\"order_id\\":\\"33333333-3333-4333-8333-333333333333\\",\\"item\\":\\"demo-monitor\\",\\"amount_cents\\":19999}"',
].join('\n');
const STEP_5 = 'node scripts/deploy-payments.mjs --version 0.1.0 --fault disabled';
const TEARDOWN = 'docker compose -f infra/docker/docker-compose.yml down';

function Command({ text }: { text: string }) {
  return (
    <pre className="command">
      <code>{text}</code>
    </pre>
  );
}

export default function DemoPage() {
  return (
    <Shell current="demo">
      <section className="demo">
        <h1>Demo flow</h1>
        <p className="summary">Run these from the repository root, in order.</p>

        <h2>1. Start the slice, including the dashboard</h2>
        <Command text={STEP_1} />
        <p>Expect web to start after ClickHouse is healthy. Open http://localhost:3000/demo to confirm.</p>

        <h2>2. Create a faulty Payments deployment</h2>
        <Command text={STEP_2} />
        <p>Expect deployment_id=&lt;uuid&gt; in the output. Note the value.</p>

        <h2>3. Send three orders</h2>
        <p>The fixed order IDs make the demo repeatable on a fresh stack.</p>
        <Command text={STEP_3} />
        <p>Each returns HTTP 502 with a payment_unavailable reason. That is the expected faulty behavior.</p>

        <h2>4. Wait for the incident, then open it</h2>
        <p>
          The correlator runs every second and the publisher follows. Open <a href="/incidents">/incidents</a>. The new
          row appears after Refresh. Click it to open the detail page.
        </p>

        <h2>5. Restore the healthy version</h2>
        <Command text={STEP_5} />
        <p>
          The incident remains, because it is historical. The Deployments page then shows 0.2.0-faulty as faulty and the
          restored 0.1.0 as the latest deployment.
        </p>

        <h2>Teardown</h2>
        <p>Teardown keeps volumes.</p>
        <Command text={TEARDOWN} />
      </section>
    </Shell>
  );
}

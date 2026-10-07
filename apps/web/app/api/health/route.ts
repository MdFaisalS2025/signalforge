// Liveness only: reports that this process serves requests. It does not query ClickHouse.
export function GET() {
  return new Response(JSON.stringify({ status: 'ok' }), {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' },
  });
}

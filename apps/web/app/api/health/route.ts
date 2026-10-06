// Liveness only: reports that this process serves requests. It does not query ClickHouse.
export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}

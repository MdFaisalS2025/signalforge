import { errorResponse, getDashboardService, jsonResponse, methodNotAllowed } from '../../../src/server/service';

// GET /api/incidents?limit=20 — newest incidents first. Read-only.
export async function GET(request: Request): Promise<Response> {
  try {
    const limit = new URL(request.url).searchParams.get('limit') ?? undefined;
    return jsonResponse(await getDashboardService().listIncidents(limit));
  } catch (error) {
    return errorResponse(error);
  }
}

// Every other method is refused explicitly, so no framework default can apply.
export function POST(): Response {
  return methodNotAllowed();
}

export function PUT(): Response {
  return methodNotAllowed();
}

export function PATCH(): Response {
  return methodNotAllowed();
}

export function DELETE(): Response {
  return methodNotAllowed();
}

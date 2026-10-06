import { errorResponse, getDashboardService, jsonResponse, methodNotAllowed } from '../../../../src/server/service';

// GET /api/incidents/{incidentId} — one incident with its explanation, deployment, and evidence. Read-only.
export async function GET(
  _request: Request,
  context: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  try {
    const { incidentId } = await context.params;
    return jsonResponse(await getDashboardService().getIncidentDetail(incidentId));
  } catch (error) {
    return errorResponse(error);
  }
}

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

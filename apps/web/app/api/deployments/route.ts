import { errorResponse, getDashboardService, jsonResponse, methodNotAllowed } from '../../../src/server/service';

// GET /api/deployments?limit=10 — recent Payments deployments with failure counts and linked incidents. Read-only.
export async function GET(request: Request): Promise<Response> {
  try {
    const limit = new URL(request.url).searchParams.get('limit') ?? undefined;
    return jsonResponse(await getDashboardService().listDeployments(limit));
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

import type { Config, Context } from "@netlify/functions";

// Scaffold probe. Reports whether Netlify's AI Gateway has injected the TypeSafe
// credentials (booleans only, never values) so we know Jev is reachable.
export default async (_req: Request, context: Context) => {
  return Response.json({
    ok: true,
    service: "infra-guardian",
    aiGateway: Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_BASE_URL),
    requestId: context.requestId,
    now: new Date().toISOString(),
  });
};

export const config: Config = { path: "/api/hello" };

import { createHash } from "node:crypto";

// Small HTTP helpers shared by the functions: validation, hashing, JSON responses with the header contract.

export const SESSION_RE = /^[A-Za-z0-9_-]{6,32}$/;

export function sessionId(url: URL): string | null {
  const s = url.searchParams.get("s");
  return s && SESSION_RE.test(s) ? s : null;
}

export function keyFor(sid: string, ...parts: string[]): string {
  return ["s", sid, ...parts].join("/");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function descriptionOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "description" in body) {
    const d = (body as { description?: unknown }).description;
    if (typeof d === "string" && d.trim().length > 0) return d.trim().slice(0, 500);
  }
  return fallback;
}

export function idempotencyKeyOf(req: Request, body: unknown): string | null {
  const h = req.headers.get("idempotency-key");
  if (h && h.length <= 128) return h;
  if (body && typeof body === "object" && "idempotencyKey" in body) {
    const k = (body as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof k === "string" && k.length > 0 && k.length <= 128) return k;
  }
  return null;
}

export async function readJson(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try {
    const text = await req.text();
    if (text.length > 4096) return null;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function flag(url: URL, name: string, def: boolean): boolean {
  const v = url.searchParams.get(name);
  if (v === null) return def;
  return !(v === "0" || v === "false" || v === "off");
}

export const BASE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) clean[k.toLowerCase()] = String(v);
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...BASE_HEADERS, ...clean } });
}

export function badRequest(message: string): Response {
  return json(400, { error: message });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clientId(req: Request, context: { ip?: string }): string {
  const ip = context.ip ?? req.headers.get("x-nf-client-connection-ip") ?? "0.0.0.0";
  return sha256(`${ip}|${req.headers.get("user-agent") ?? ""}`).slice(0, 16);
}

/**
 * Request authentication shared by the REST API (server.ts) and the tools
 * authoring MCP (tools-mcp.ts). Extracted from server.ts so both surfaces
 * resolve callers identically without a circular import.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { TokenRegistry, TaskScope } from "./tokens.ts";

export type Auth = { kind: "admin" } | { kind: "task"; scope: TaskScope } | null;

/** Constant-time string equality (length-guarded timingSafeEqual). */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resolve the caller: the admin token (Bearer or `?token=`, the latter admin-only
 * for the UI) or a per-task capability token (Bearer only). No/invalid token =>
 * null (401). A task token is scoped to its conversation (rootId).
 */
export function resolveAuth(request: FastifyRequest, adminToken: string, tokens: TokenRegistry): Auth {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const bearer = header.slice("Bearer ".length);
    if (secretEquals(bearer, adminToken)) return { kind: "admin" };
    const scope = tokens.resolve(bearer);
    if (scope) return { kind: "task", scope };
  }
  const queryToken = (request.query as { token?: string }).token;
  if (queryToken && secretEquals(queryToken, adminToken)) return { kind: "admin" };
  return null;
}

export function deny(reply: FastifyReply): void {
  reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorised" });
}

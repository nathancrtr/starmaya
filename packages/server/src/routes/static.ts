import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Resolves the absolute path to packages/client/dist regardless of where the
 * server is being run from. The compiled server lives at
 *   packages/server/dist/routes/static.js
 * and the client build sits at
 *   packages/client/dist/
 * so we walk up four levels from this file's directory.
 */
function resolveClientDist(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "client", "dist");
}

/**
 * If a built client bundle exists, serve it as static files alongside the API
 * routes, with a SPA fallback that returns index.html for any non-/api path.
 *
 * If the build doesn't exist (typical during `pnpm dev` when the client is
 * being served by Vite), this is a no-op — the server only handles /api in
 * that mode and Vite handles the rest.
 */
export async function registerStaticRoute(
  fastify: FastifyInstance,
  log: (level: string, msg: string, extra?: object) => void,
): Promise<void> {
  const clientDist = resolveClientDist();
  const indexPath = join(clientDist, "index.html");

  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    log("info", "client_bundle_not_served", {
      reason: "missing index.html",
      checked: clientDist,
    });
    return;
  }

  await fastify.register(fastifyStatic, {
    root: clientDist,
    prefix: "/",
    // We rely on reply.sendFile in the SPA fallback below, so leave the
    // decorator on (the default).
  });

  // SPA fallback: any GET request that didn't match an /api route or a
  // physical file gets index.html. The browser's router handles the path
  // from there. Non-GET methods get a normal 404.
  fastify.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/")) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    reply.type("text/html").sendFile("index.html");
  });

  log("info", "client_bundle_served", { root: clientDist });
}

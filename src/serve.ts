#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { createHandler } from "./http.js";
import { VERSION } from "./server.js";

/**
 * HTTP entry point, kept separate from http.ts so importing the handler
 * doesn't start listening.
 *
 * Note this streams over SSE rather than buffering a JSON response. That is
 * load-bearing behind a router that times out an idle request: the response
 * begins immediately and the SDK heartbeats while a job runs, instead of
 * sending nothing until the work is done.
 */

// Platforms assign the port; binding anything else usually fails to boot.
const port = Number(process.env.PORT ?? 3000);

createHttpServer(createHandler()).listen(port, () => {
  console.error(`Bannerbear MCP ${VERSION} ready (http, port ${port})`);
});

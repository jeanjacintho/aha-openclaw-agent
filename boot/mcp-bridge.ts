import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const url = process.env.PLOW_MCP_URL;
const token = process.env.PLOW_AGENT_TOKEN;
const bridgeToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
if (!url || !token || !bridgeToken) throw new Error("PLOW_MCP_URL, PLOW_AGENT_TOKEN and PLOW_MCP_BRIDGE_TOKEN are required");

// Preserve each client's MCP session and HTTP result; never replay a request.
createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
    response.writeHead(401).end("Unauthorized");
    return;
  }
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    for (const key of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "last-event-id"]) {
      const value = request.headers[key];
      if (typeof value === "string") headers.set(key, value);
    }
    const upstream = await fetch(url, {
      method: request.method, redirect: "error", signal: controller.signal, headers,
      body: ["GET", "HEAD"].includes(request.method!) ? undefined : Buffer.concat(chunks),
    });
    for (const key of ["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"]) {
      const value = upstream.headers.get(key);
      if (value) response.setHeader(key, value);
    }
    response.writeHead(upstream.status);
    response.flushHeaders();
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch {
    if (!response.headersSent && !response.destroyed) response.writeHead(502).end("Relay request failed");
    else response.destroy();
  }
}).listen(18790, "127.0.0.1", () => process.send?.("ready"));

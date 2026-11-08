import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readText, UserError } from './net.js';

export function createHttpMcp(makeServer) {
  return createHttpServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    const reject = (status, code, message) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
    };
    const port = req.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origins = hosts.map((host) => `http://${host}`);
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) {
      return reject(403, -32000, 'Host or origin is not allowed.');
    }
    if (req.url !== '/mcp') return reject(404, -32000, 'Use /mcp.');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reject(405, -32000, 'Use POST. This server does not keep SSE sessions.');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return reject(415, -32000, 'Use application/json.');
    }
    let body;
    try {
      body = JSON.parse(await readText(req.iterator({ destroyOnReturn: false }), 128 * 1024));
    } catch (error) {
      res.setHeader('Connection', 'close');
      return error instanceof UserError ? reject(413, -32000, 'Request is too large.') :
        reject(400, -32700, 'Invalid JSON.');
    }

    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.setHeader('Cache-Control', 'no-store');
    res.on('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      reject(500, -32603, 'Internal MCP server error.');
    }
  });
}

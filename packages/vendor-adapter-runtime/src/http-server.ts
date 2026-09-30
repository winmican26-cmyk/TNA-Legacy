import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { URL } from 'node:url';
import type { VendorAdapterRuntime, VendorMediatedActionInput } from './index.js';

/**
 * HTTP Server wrapper for VendorAdapterRuntime
 * Exposes the vendor-mediated action execution as HTTP endpoints
 * for the PreToolUse hook to call.
 */

export interface VendorAdapterHttpServerOptions {
  runtime: VendorAdapterRuntime;
  port: number;
  host?: string;
  // Authentication for the hook endpoint
  authToken?: string;
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function checkAuth(req: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${expectedToken}`;
}

export function createVendorAdapterHttpServer(options: VendorAdapterHttpServerOptions): Promise<Server<typeof IncomingMessage, typeof ServerResponse>> {
  const { runtime, port, host = '0.0.0.0', authToken } = options;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

    // CORS for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check for protected endpoints
    if (!checkAuth(req, authToken)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
        return;
      }

      if (req.method === 'POST' && path === '/vendor/execute') {
        const body = await parseBody(req) as Partial<VendorMediatedActionInput>;

        // Validate required fields
        if (!body.vendor || !body.tenant || !body.principal || !body.agent_identity || !body.vendor_event || !body.authority) {
          sendJson(res, 400, { error: 'Missing required fields: vendor, tenant, principal, agent_identity, vendor_event, authority' });
          return;
        }

        // Create a platform principal for the request
        const platformPrincipal: { id: string; tenantId: string; agentId: string; role: 'platform-agent' } = {
          id: `hook-${body.tenant}`,
          tenantId: body.tenant,
          agentId: body.agent_identity,
          role: 'platform-agent',
        };

        // Execute through the runtime's public hook method
        const input: VendorMediatedActionInput = {
          vendor: body.vendor,
          tenant: body.tenant,
          principal: body.principal,
          agent_identity: body.agent_identity,
          vendor_config: body.vendor_config ?? {},
          vendor_event: body.vendor_event,
          authority: body.authority,
        };

        const result = await runtime.executeVendorActionForHook(input, platformPrincipal);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && path === '/vendor/cancel') {
        const body = await parseBody(req) as { vendor?: string; vendor_session_id?: string; sentinel_session_id?: string; reason?: string; mode?: 'terminate' | 'hold' };
        if (!body.vendor || !body.vendor_session_id || !body.sentinel_session_id) {
          sendJson(res, 400, { error: 'Missing vendor, vendor_session_id, sentinel_session_id' });
          return;
        }
        const result = await runtime.cancelVendorSessionWithSentinel(
          body.vendor,
          body.vendor_session_id,
          body.sentinel_session_id,
          body.reason ?? 'Hook cancellation',
          body.mode ?? 'terminate'
        );
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && path === '/vendor/usage') {
        const vendor = url.searchParams.get('vendor');
        const vendor_session_id = url.searchParams.get('vendor_session_id');
        if (!vendor || !vendor_session_id) {
          sendJson(res, 400, { error: 'Missing vendor, vendor_session_id' });
          return;
        }
        const result = await runtime.collectVendorUsage(vendor, vendor_session_id);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[TNA-HTTP] Error:', error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Internal error' });
    }
  });

  return new Promise<Server<typeof IncomingMessage, typeof ServerResponse>>((resolve, reject) => {
    server.listen(port, host, () => {
      console.log(`[TNA-HTTP] Server listening on http://${host}:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// Re-export for convenience
export { VendorAdapterRuntime } from './index.js';
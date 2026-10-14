import type { AuthMethod, WebSocketCapability, WebSocketChannel, WebSocketSession } from './types/api.d.ts';

const parseFrame = (data: string | Uint8Array) => JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));

// Core runs authorize() first and persists any refreshed OAuth credentials.
export function withWebSocketAuth(method: AuthMethod): AuthMethod {
  return {
    ...method,
    async authenticateWebSocket(channel, conn, { signal }) {
      const greeting = parseFrame(await channel.receive(signal));
      if (greeting.type !== 'auth_required') throw new Error('Unexpected Home Assistant authentication greeting');
      if (!method.token) throw new Error('Home Assistant authentication requires a bearer token');
      const token = await method.token(conn, { signal });
      await channel.send(JSON.stringify({ type: 'auth', access_token: token.accessToken }));
      const response = parseFrame(await channel.receive(signal));
      if (response.type === 'auth_invalid') {
        throw Object.assign(new Error('Home Assistant rejected WebSocket authentication'), { code: 'WEBSOCKET_AUTH_REJECTED' });
      }
      if (response.type !== 'auth_ok') throw new Error('Unexpected Home Assistant authentication response');
      return token.credentials === undefined ? undefined : { credentials: token.credentials };
    },
  };
}

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const urlPath = { type: ['string', 'null'], description: 'Dashboard URL path; omit or use null for the default dashboard.' };

export const websocket: WebSocketCapability = {
  proxy: true,
  endpoint: conn => `${String(conn.config.url).replace(/\/+$/, '')}/api/websocket`,
  operations: [
    { id: 'system_log/list', rest: { method: 'GET', path: '/system/logs' }, title: 'Read system logs', description: 'Recent condensed errors and warnings (admin required).', mode: 'command', inputSchema: object(), outputSchema: { type: 'array', items: { type: 'object' } }, readOnlyHint: true },
    { id: 'system_log/subscribe_raw', title: 'Stream raw system logs', description: 'Stream raw log lines with an initial backlog, optionally filtered by integration. Requires an admin and a Home Assistant version supporting system_log/subscribe_raw.', mode: 'subscription', inputSchema: object({ integration: { type: 'string', description: 'Integration domain, e.g. mqtt.' } }), eventSchema: { type: 'array', items: { type: 'string' } }, readOnlyHint: true },
    { id: 'system_log/subscribe', title: 'Watch system logs', description: 'Watch warning/error events. Requires system_log.fire_event: true in Home Assistant configuration.', mode: 'subscription', inputSchema: object(), eventSchema: { type: 'object' }, readOnlyHint: true },
    { id: 'lovelace/dashboards/list', rest: { method: 'GET', path: '/lovelace/dashboards' }, title: 'List Lovelace dashboards', description: 'List named dashboards and their storage/YAML mode. The default dashboard may not appear on older instances.', mode: 'command', inputSchema: object(), outputSchema: { type: 'array', items: { type: 'object' } }, readOnlyHint: true },
    { id: 'lovelace/config', rest: { method: 'GET', path: '/lovelace/config' }, title: 'Read Lovelace dashboard', mode: 'command', inputSchema: object({ url_path: urlPath, force: { type: 'boolean', description: 'Reload dashboard configuration from storage.' } }), outputSchema: { type: 'object' }, readOnlyHint: true },
    { id: 'lovelace/config/save', rest: { method: 'PUT', path: '/lovelace/config' }, title: 'Save Lovelace dashboard', description: 'Replace the entire dashboard configuration. Read and preserve existing fields first. Requires an admin and a storage-mode dashboard; YAML dashboards cannot be saved through this API.', mode: 'command', inputSchema: object({ url_path: urlPath, config: { type: 'object', additionalProperties: true, description: 'Complete dashboard configuration, including views or strategy.' } }, ['config']), outputSchema: { type: 'null' }, readOnlyHint: false, idempotentHint: true },
    { id: 'lovelace/subscribe', title: 'Watch Lovelace updates', description: 'Watch lovelace_updated events for dashboard changes.', mode: 'subscription', inputSchema: object(), eventSchema: { type: 'object' }, readOnlyHint: true },
  ],
  createSession: ({ channel, signal }) => createSession(channel, signal),
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export function createSession(channel: WebSocketChannel, signal: AbortSignal): WebSocketSession {
  let counter = 0;
  let ended = false;
  const pending = new Map<number, Pending>();
  const subscriptionCleanups = new Set<() => void>();
  const events = new Map<number, (event: unknown) => void>();
  const receiver = new AbortController();
  const receiveSignal = AbortSignal.any([signal, receiver.signal]);
  const disconnected = () => new Error('Home Assistant WebSocket disconnected');
  const dispose = () => {
    if (ended) return;
    ended = true;
    receiver.abort();
    for (const call of pending.values()) call.reject(disconnected());
    pending.clear();
    events.clear();
    for (const cleanup of subscriptionCleanups) cleanup();
    subscriptionCleanups.clear();
    signal.removeEventListener('abort', dispose);
  };
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  void channel.closed.then(dispose, dispose);

  const exchange = (type: string, args: Record<string, unknown>, operationSignal: AbortSignal, emit?: (event: unknown) => void) => {
    const id = ++counter;
    const result = new Promise<unknown>((resolve, reject) => {
      if (ended) { reject(disconnected()); return; }
      if (operationSignal.aborted) { reject(new Error('Home Assistant operation cancelled')); return; }
      if (emit) events.set(id, emit);
      const clean = () => {
        pending.delete(id);
        operationSignal.removeEventListener('abort', abort);
      };
      const abort = () => {
        clean();
        events.delete(id);
        // Core closes the session on command cancellation. A cancelled subscription
        // start must also release the upstream subscription, even before its ACK.
        if (emit && !ended) {
          void exchange('unsubscribe_events', { subscription: id }, receiveSignal).result.catch(() => {});
        }
        reject(new Error('Home Assistant operation cancelled'));
      };
      pending.set(id, {
        resolve(value) { clean(); resolve(value); },
        reject(error) { clean(); events.delete(id); reject(error); },
      });
      operationSignal.addEventListener('abort', abort, { once: true });
      void channel.send(JSON.stringify({ ...args, id, type })).catch(() => {
        pending.get(id)?.reject(new Error('Could not send Home Assistant WebSocket command'));
      });
    });
    return { id, result };
  };

  void (async () => {
    try {
      while (!receiveSignal.aborted) {
        const msg = parseFrame(await channel.receive(receiveSignal));
        if (msg.type === 'event') events.get(msg.id)?.(msg.event);
        else if (msg.type === 'result') {
          const call = pending.get(msg.id);
          if (msg.success === true) call?.resolve(msg.result);
          else call?.reject(Object.assign(new Error(`Home Assistant command failed (${String(msg.error?.code ?? 'unknown')})`), { code: msg.error?.code }));
        }
      }
    } catch { dispose(); }
  })();

  const commandIds = new Set(websocket.operations.filter(op => op.mode === 'command').map(op => op.id));
  const subscriptionTypes: Record<string, string> = { 'system_log/subscribe': 'system_log_event', 'lovelace/subscribe': 'lovelace_updated' };
  return {
    call(operationId, args, operationSignal) {
      if (!commandIds.has(operationId)) return Promise.reject(new Error('Unknown Home Assistant command'));
      return exchange(operationId, args, operationSignal).result;
    },
    async subscribe(operationId, args, emit, operationSignal) {
      const eventType = subscriptionTypes[operationId];
      const raw = operationId === 'system_log/subscribe_raw';
      if (!eventType && !raw) throw new Error('Unknown Home Assistant subscription');
      const request = raw
        ? exchange('system_log/subscribe_raw', args, operationSignal, emit)
        : exchange('subscribe_events', { event_type: eventType }, operationSignal, emit);
      await request.result;
      if (ended) throw disconnected();
      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        cleanup();
        subscriptionCleanups.delete(cleanup);
        events.delete(request.id);
        if (!ended) await exchange('unsubscribe_events', { subscription: request.id }, receiveSignal).result;
      };
      const onAbort = () => { void stop().catch(() => {}); };
      const cleanup = () => operationSignal.removeEventListener('abort', onAbort);
      subscriptionCleanups.add(cleanup);
      operationSignal.addEventListener('abort', onAbort, { once: true });
      if (operationSignal.aborted) await stop();
      return { stop };
    },
    dispose,
  };
}

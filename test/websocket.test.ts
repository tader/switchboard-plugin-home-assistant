import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession, websocket, withWebSocketAuth } from '../plugins/home-assistant/websocket.ts';
import type { AuthMethod, Connection, WebSocketChannel } from '../plugins/home-assistant/types/api.d.ts';

class Channel implements WebSocketChannel {
  sent: Record<string, any>[] = [];
  queue: string[] = [];
  waiter?: { resolve(value: string): void; reject(error: Error): void };
  close!: () => void;
  closed = new Promise<void>(resolve => { this.close = resolve; });
  async send(data: string | Uint8Array) { this.sent.push(JSON.parse(String(data))); }
  receive(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const frame = this.queue.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(new Error('Cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiter = {
        resolve(value) { signal?.removeEventListener('abort', abort); resolve(value); },
        reject,
      };
    });
  }
  push(value: unknown) {
    const frame = JSON.stringify(value);
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(frame); }
    else this.queue.push(frame);
  }
  reply(id: number, result: unknown = null) { this.push({ id, type: 'result', success: true, result }); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const live = () => new AbortController().signal;
const connection: Connection = { id: 'ha', name: 'HA', serviceId: 'home-assistant', methodId: 'token', config: { url: 'https://ha.example/prefix/' }, credentials: { token: 'secret' } };
const method = (token: AuthMethod['token']): AuthMethod => ({ id: 'token', name: 'Token', connect: () => ({ credentials: {} }), authorize() {}, token });

for (const key of ['token', 'accessToken']) {
  test(`authenticates ${key} credentials and persists token refresh`, async () => {
    const channel = new Channel();
    channel.push({ type: 'auth_required' }); channel.push({ type: 'auth_ok' });
    const auth = withWebSocketAuth(method(async (conn, opts) => {
      assert.equal(opts.force, undefined); // authorize already performed the forced refresh
      return { accessToken: conn.credentials[key], credentials: { refreshed: true } };
    }));
    const result = await auth.authenticateWebSocket!(channel, { ...connection, credentials: { [key]: 'secret' } }, { force: true, signal: live() });
    assert.deepEqual(channel.sent, [{ type: 'auth', access_token: 'secret' }]);
    assert.deepEqual(result, { credentials: { refreshed: true } });
  });
}

test('auth rejection is retryable and never echoes the upstream token', async () => {
  const channel = new Channel();
  channel.push({ type: 'auth_required' }); channel.push({ type: 'auth_invalid', message: 'secret' });
  const auth = withWebSocketAuth(method(async () => ({ accessToken: 'secret' })));
  await assert.rejects(auth.authenticateWebSocket!(channel, connection, { force: false, signal: live() }), { code: 'WEBSOCKET_AUTH_REJECTED', message: 'Home Assistant rejected WebSocket authentication' });
});

test('preserves endpoint prefixes and serializes the complete dashboard without reserved field overrides', async t => {
  assert.equal((websocket.endpoint as (conn: Connection) => string)(connection), 'https://ha.example/prefix/api/websocket');
  const channel = new Channel(); const session = createSession(channel, live());
  t.after(() => session.dispose?.());
  const config = { views: [{ title: 'Home', cards: [{ type: 'entities', entities: ['light.kitchen'] }] }], custom: true };
  const result = session.call('lovelace/config/save', { config, url_path: 'my-home', id: 999, type: 'evil' }, live());
  assert.deepEqual(channel.sent[0], { id: 1, type: 'lovelace/config/save', config, url_path: 'my-home' });
  channel.reply(1); assert.equal(await result, null);
});

test('matches concurrent replies and rejects upstream failures', async t => {
  const channel = new Channel(); const session = createSession(channel, live());
  t.after(() => session.dispose?.());
  const logs = session.call('system_log/list', {}, live());
  const dashboard = session.call('lovelace/config', {}, live());
  channel.reply(2, { views: [] }); channel.reply(1, [{ level: 'ERROR' }]);
  assert.deepEqual(await dashboard, { views: [] }); assert.deepEqual(await logs, [{ level: 'ERROR' }]);
  const save = session.call('lovelace/config/save', { config: {} }, live());
  channel.push({ id: 3, type: 'result', success: false, error: { code: 'unauthorized', message: 'private data' } });
  await assert.rejects(save, { code: 'unauthorized', message: 'Home Assistant command failed (unauthorized)' });
});

for (const [operation, type, args, event] of [
  ['system_log/subscribe', 'subscribe_events', { event_type: 'system_log_event' }, { data: { level: 'ERROR' } }],
  ['lovelace/subscribe', 'subscribe_events', { event_type: 'lovelace_updated' }, { data: { url_path: 'my-home' } }],
  ['system_log/subscribe_raw', 'system_log/subscribe_raw', { integration: 'mqtt' }, ['initial line', 'new line']],
] as const) {
  test(`${operation} retains early events and unsubscribes once with acknowledgement`, async t => {
    const channel = new Channel(); const session = createSession(channel, live());
    t.after(() => session.dispose?.());
    const events: unknown[] = []; let acknowledged = false;
    const subscription = session.subscribe!(operation, operation.endsWith('_raw') ? { integration: 'mqtt' } : {}, value => events.push(value), live()).then(value => { acknowledged = true; return value; });
    assert.deepEqual(channel.sent[0], { id: 1, type, ...args });
    channel.push({ id: 1, type: 'event', event }); await tick();
    assert.deepEqual(events, [event]); assert.equal(acknowledged, false);
    channel.reply(1); const handle = await subscription;
    const stop = handle.stop!(); assert.deepEqual(channel.sent[1], { id: 2, type: 'unsubscribe_events', subscription: 1 });
    channel.reply(2); await stop; await handle.stop!();
    channel.push({ id: 1, type: 'event', event }); await tick();
    assert.equal(events.length, 1); assert.equal(channel.sent.length, 2);
  });
}

test('cancelled commands discard late replies without corrupting later commands', async t => {
  const channel = new Channel(); const session = createSession(channel, live());
  t.after(() => session.dispose?.());
  const controller = new AbortController(); const call = session.call('system_log/list', {}, controller.signal);
  const rejected = assert.rejects(call, /cancelled/); controller.abort(); await rejected;
  const next = session.call('lovelace/config', {}, live());
  channel.reply(1, []); channel.reply(2, { views: [] }); assert.deepEqual(await next, { views: [] });
});

test('cancellation before subscription acknowledgement releases upstream work', async t => {
  const channel = new Channel(); const session = createSession(channel, live());
  t.after(() => session.dispose?.());
  const controller = new AbortController(); const events: unknown[] = [];
  const call = session.subscribe!('system_log/subscribe', {}, value => events.push(value), controller.signal);
  const rejected = assert.rejects(call, /cancelled/); controller.abort(); await rejected;
  assert.deepEqual(channel.sent[1], { id: 2, type: 'unsubscribe_events', subscription: 1 });
  channel.reply(1); channel.reply(2); channel.push({ type: 'event', id: 1, event: {} }); await tick();
  assert.deepEqual(events, []);
});

test('subscription lifetime cancellation stops upstream and does not await events', async t => {
  const channel = new Channel(); const session = createSession(channel, live());
  t.after(() => session.dispose?.());
  const controller = new AbortController();
  const call = session.subscribe!('system_log/subscribe', {}, () => {}, controller.signal);
  channel.reply(1); await call; controller.abort();
  assert.deepEqual(channel.sent[1], { id: 2, type: 'unsubscribe_events', subscription: 1 }); channel.reply(2); await tick();
});

for (const close of ['abort', 'close', 'dispose', 'malformed'] as const) {
  test(`${close} rejects pending requests and ends the receive loop`, async () => {
    const channel = new Channel(); const controller = new AbortController(); const session = createSession(channel, controller.signal);
    const rejected = assert.rejects(session.call('system_log/list', {}, live()), /disconnected/);
    if (close === 'abort') controller.abort();
    if (close === 'close') channel.close();
    if (close === 'dispose') session.dispose!();
    if (close === 'malformed') channel.push(null);
    await rejected;
    await assert.rejects(session.call('system_log/list', {}, live()), /disconnected/);
    assert.equal(channel.waiter, undefined);
  });
}

test('send failure rejects only the affected operation', async () => {
  const channel = new Channel(); channel.send = async () => { throw new Error('secret'); };
  const session = createSession(channel, live());
  await assert.rejects(session.call('system_log/list', {}, live()), { message: 'Could not send Home Assistant WebSocket command' });
  session.dispose!();
});


test('authentication and protocol replies accept Uint8Array text frames', async () => {
  const channel = new Channel();
  const frames = [{ type: 'auth_required' }, { type: 'auth_ok' }];
  const authChannel: WebSocketChannel = {
    send: data => channel.send(data), closed: channel.closed,
    receive: async () => new TextEncoder().encode(JSON.stringify(frames.shift())),
  };
  const auth = withWebSocketAuth(method(async () => ({ accessToken: 'secret' })));
  await auth.authenticateWebSocket!(authChannel, connection, { force: false, signal: live() });
  const binaryChannel: WebSocketChannel = {
    send: data => channel.send(data), closed: channel.closed,
    receive: async signal => new TextEncoder().encode(await channel.receive(signal)),
  };
  const session = createSession(binaryChannel, live());
  const call = session.call('system_log/list', {}, live()); channel.reply(1, []);
  assert.deepEqual(await call, []); session.dispose!();
});


test('dedicated REST endpoints map to the HA commands and raw proxy is enabled', () => {
  assert.equal(websocket.proxy, true);
  assert.deepEqual(websocket.operations.filter(op => op.rest).map(op => [op.rest!.method, op.rest!.path, op.id]), [
    ['GET', '/system/logs', 'system_log/list'],
    ['GET', '/lovelace/dashboards', 'lovelace/dashboards/list'],
    ['GET', '/lovelace/config', 'lovelace/config'],
    ['PUT', '/lovelace/config', 'lovelace/config/save'],
  ]);
  assert.ok(websocket.operations.filter(op => op.rest?.method === 'GET').every(op => op.readOnlyHint === true));
});

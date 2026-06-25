import {
  makeEnvelope,
  parseEnvelope,
  permissionDecisionPayloadSchema,
  sessionControlPayloadSchema,
  sessionLaunchPayloadSchema,
  type Envelope,
  type MessageType,
  type SessionHistoryEntry,
  type SessionStatusName,
} from '@telecode/protocol';

/**
 * A deterministic stand-in daemon for the web e2e. It speaks the wire protocol directly (no Agent SDK,
 * no model call) so the browser drives a real relay round-trip across the multi-session dashboard + the
 * per-id session view. On `session.launch` it streams a message then a `Write` tool gated behind
 * `agent.permission_request`; on the human's `permission.decision` it runs the tool only when allowed and
 * finishes. It records each session's transcript (like the real daemon) and backfills it on
 * `session.subscribe` via `session.history`, so the reload-is-reconnect flow works. Run as a child
 * process by the session e2e; reads its identity from the environment.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`fake-daemon: missing ${name}`);
    process.exit(1);
  }
  return value;
}

const relayUrl = process.env.RELAY_WS_URL ?? 'ws://127.0.0.1:8080/ws';
const userId = required('FAKE_USER_ID');
const deviceId = required('FAKE_DEVICE_ID');
const deviceToken = required('FAKE_DEVICE_TOKEN');

const DEFAULT_INPUT = { path: 'README.md', content: 'hello from telecode' };

const socket = new WebSocket(relayUrl);
let requestSeq = 0;

interface SessionRecord {
  status: SessionStatusName;
  transcript: SessionHistoryEntry[];
}
const records = new Map<string, SessionRecord>();

function recordFor(sessionId: string): SessionRecord {
  let record = records.get(sessionId);
  if (!record) {
    record = { status: 'starting', transcript: [] };
    records.set(sessionId, record);
  }
  return record;
}

function send(type: MessageType, payload: unknown, sessionId?: string): void {
  socket.send(
    JSON.stringify(
      makeEnvelope({
        type,
        userId,
        deviceId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        payload,
      }),
    ),
  );
}

socket.addEventListener('open', () => {
  send('hello', { role: 'daemon', token: deviceToken });
});

socket.addEventListener('message', (event: MessageEvent) => {
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(JSON.parse(String(event.data)));
  } catch {
    return;
  }

  if (envelope.type === 'hello.ack') {
    console.log('fake-daemon: ready');
    return;
  }

  const sid = envelope.session_id;
  if (sid === undefined) return;

  if (envelope.type === 'session.launch') {
    const launch = sessionLaunchPayloadSchema.safeParse(envelope.payload);
    const rec = recordFor(sid);
    if (launch.success) rec.transcript.push({ kind: 'user', text: launch.data.prompt });
    rec.status = 'running';
    const clientRef = launch.success ? launch.data.clientRef : undefined;
    send('session.started', clientRef !== undefined ? { clientRef } : {}, sid);

    rec.transcript.push({ kind: 'message', text: 'Planning the change' });
    send('agent.message', { text: 'Planning the change' }, sid);

    const requestId = `req-${++requestSeq}`;
    rec.transcript.push({
      kind: 'permission',
      requestId,
      toolName: 'Write',
      input: DEFAULT_INPUT,
      decision: 'pending',
    });
    rec.status = 'awaiting_input';
    send('agent.permission_request', { requestId, toolName: 'Write', input: DEFAULT_INPUT }, sid);
    return;
  }

  if (envelope.type === 'permission.decision') {
    const decision = permissionDecisionPayloadSchema.safeParse(envelope.payload);
    if (!decision.success) return;
    const rec = recordFor(sid);
    const gate = rec.transcript.find(
      (e) => e.kind === 'permission' && e.requestId === decision.data.requestId,
    );
    if (gate?.kind === 'permission') gate.decision = decision.data.behavior;
    rec.status = 'running';

    if (decision.data.behavior === 'allow') {
      const input = decision.data.updatedInput ?? DEFAULT_INPUT;
      rec.transcript.push({ kind: 'tool', toolName: 'Write', input });
      send('agent.tool_use', { toolName: 'Write', input }, sid);
    }
    rec.transcript.push({ kind: 'message', text: 'Finished' });
    send('agent.message', { text: 'Finished' }, sid);
    rec.status = 'done';
    send('session.ended', { status: 'done' }, sid);
    return;
  }

  if (envelope.type === 'user.message') {
    // A follow-up turn — resume the conversation with a short, ungated response.
    const rec = recordFor(sid);
    rec.transcript.push({ kind: 'message', text: 'Following up as requested' });
    rec.status = 'done';
    send('agent.message', { text: 'Following up as requested' }, sid);
    send('session.ended', { status: 'done' }, sid);
    return;
  }

  if (envelope.type === 'session.control') {
    const control = sessionControlPayloadSchema.safeParse(envelope.payload);
    if (!control.success) return;
    const rec = recordFor(sid);
    const action = control.data.action;
    if (action === 'interrupt' || action === 'end') {
      // Settle any pending gate and end the current turn (mirrors the daemon's stop-turn).
      const gate = rec.transcript.find((e) => e.kind === 'permission' && e.decision === 'pending');
      if (gate?.kind === 'permission') gate.decision = 'deny';
      rec.status = 'done';
      send('session.ended', { status: 'done' }, sid);
    } else if (action === 'pause') {
      rec.status = 'paused';
      send('session.status', { status: 'paused' }, sid);
    } else if (action === 'resume') {
      rec.status = 'running';
      send('session.status', { status: 'running' }, sid);
    }
    return;
  }

  if (envelope.type === 'session.subscribe') {
    // Reopen = reconnect: backfill the recorded transcript so a reloaded browser restores its view.
    const rec = records.get(sid);
    send(
      'session.history',
      rec
        ? { status: rec.status, entries: rec.transcript }
        : { status: 'offline_paused', entries: [] },
      sid,
    );
  }
});

socket.addEventListener('error', () => {
  console.error('fake-daemon: socket error');
});

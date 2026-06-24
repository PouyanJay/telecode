import {
  makeEnvelope,
  parseEnvelope,
  permissionDecisionPayloadSchema,
  type Envelope,
  type MessageType,
} from '@telecode/protocol';

/**
 * A deterministic stand-in daemon for the session-view e2e. It speaks the wire protocol directly (no
 * Agent SDK, no model call) so the browser drives a real relay round-trip: on `session.launch` it streams
 * a message, then a `Write` tool gated behind `agent.permission_request`, and on the human's
 * `permission.decision` it runs the tool only when allowed (honoring an edited input), then finishes.
 * Run as a child process by the session e2e; reads its identity from the environment.
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

  if (envelope.type === 'session.launch') {
    const sid = envelope.session_id;
    send('session.started', {}, sid);
    send('agent.message', { text: 'Planning the change' }, sid);
    send(
      'agent.permission_request',
      { requestId: `req-${++requestSeq}`, toolName: 'Write', input: DEFAULT_INPUT },
      sid,
    );
    return;
  }

  if (envelope.type === 'permission.decision') {
    const decision = permissionDecisionPayloadSchema.safeParse(envelope.payload);
    const sid = envelope.session_id;
    if (decision.success && decision.data.behavior === 'allow') {
      send(
        'agent.tool_use',
        { toolName: 'Write', input: decision.data.updatedInput ?? DEFAULT_INPUT },
        sid,
      );
    }
    send('agent.message', { text: 'Finished' }, sid);
    send('session.ended', { status: 'done' }, sid);
  }
});

socket.addEventListener('error', () => {
  console.error('fake-daemon: socket error');
});

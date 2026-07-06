import {
  makeEnvelope,
  parseEnvelope,
  permissionDecisionPayloadSchema,
  sessionAdoptedPayloadSchema,
  sessionChainedPayloadSchema,
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
/**
 * Multi-device e2e (ux Phase 5): when set, this daemon announces one adopted session titled with
 * the value right after registering, and immediately gates it on a Write approval — a pending
 * decision originating on THIS device, so the spec can prove a second device's approvals arrive
 * and resolve through its own channel.
 */
const adoptAnnounceTitle = process.env.FAKE_ADOPT_ANNOUNCE;
const ADOPT_ANNOUNCE_REF = 'auto-adopt';

const DEFAULT_INPUT = { path: 'README.md', content: 'hello from telecode' };

/**
 * Launch prompt that triggers the chained-thread dance (ux Phase 3): the daemon ends the trigger
 * session immediately, announces an adopted "terminal" session with a mirrored transcript, then
 * registers a telecode continuation chained to it — producing a real parent→child pair in the registry
 * so the e2e can assert the collapsed thread row, lineage strip, and takeover divider.
 */
const CHAIN_PROMPT = 'chain a takeover';
// Magic prompt: the run exhausts its turn budget (ux Phase 6 T2) — ends `turn_limit`, stays followable.
const TURN_LIMIT_PROMPT = 'hit the turn limit';
const CHAIN_PARENT_REF = 'chain-parent';
const CHAIN_CHILD_REF = 'chain-child';
// Overridable so the spec can use a per-run unique title — earlier runs' chains persist in the
// registry, and a fixed title would make "exactly one thread row" impossible on a reused local DB.
const CHAIN_PARENT_TITLE = process.env.FAKE_CHAIN_TITLE ?? 'Fix the pairing bug';

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
    if (adoptAnnounceTitle !== undefined) {
      send('session.adopted', { clientRef: ADOPT_ANNOUNCE_REF, title: adoptAnnounceTitle });
    }
    console.log('fake-daemon: ready');
    return;
  }

  const sid = envelope.session_id;
  if (sid === undefined) return;

  // The relay's adopted-announce ACK, branched by which announce it confirms: the auto-announced
  // multi-device session (bring it live + gate it on a Write approval, exactly like a launched
  // session's gate) or the chain-dance parent (mirror a "terminal" transcript, end it, register
  // the continuation).
  if (envelope.type === 'session.adopted') {
    const ack = sessionAdoptedPayloadSchema.safeParse(envelope.payload);
    if (!ack.success) return;
    if (ack.data.clientRef === ADOPT_ANNOUNCE_REF) {
      const rec = recordFor(sid);
      rec.transcript.push(
        { kind: 'user', text: `Working on ${adoptAnnounceTitle ?? 'a task'}` },
        { kind: 'message', text: 'About to write the change' },
      );
      const requestId = `req-${++requestSeq}`;
      rec.transcript.push({
        kind: 'permission',
        requestId,
        toolName: 'Write',
        input: DEFAULT_INPUT,
        decision: 'pending',
      });
      rec.status = 'awaiting_input';
      send('agent.message', { text: 'About to write the change' }, sid);
      send('agent.permission_request', { requestId, toolName: 'Write', input: DEFAULT_INPUT }, sid);
      return;
    }
    if (ack.data.clientRef !== CHAIN_PARENT_REF) return;
    const rec = recordFor(sid);
    const base = Date.now() - 60 * 60_000; // the terminal stretch ran an hour ago
    rec.transcript.push(
      { kind: 'user', text: 'Investigate the flaky pairing', ts: base },
      { kind: 'message', text: 'Found the race in the token poll', ts: base + 60_000 },
    );
    rec.status = 'done';
    send('session.ended', { status: 'done' }, sid);
    send('session.chained', {
      clientRef: CHAIN_CHILD_REF,
      parentSessionId: sid,
      title: 'Continuing: fix the pairing bug',
    });
    return;
  }

  // The relay's chained ACK: the continuation's row exists, linked to the parent. Bring it live.
  if (envelope.type === 'session.chained') {
    const ack = sessionChainedPayloadSchema.safeParse(envelope.payload);
    if (!ack.success || ack.data.clientRef !== CHAIN_CHILD_REF) return;
    const rec = recordFor(sid);
    // One stamp per entry, minted once — the live frame and the backfill must carry the SAME instant
    // (the real daemon's record-time invariant).
    const userTs = Date.now() - 5 * 60_000;
    const messageTs = Date.now() - 4 * 60_000;
    rec.transcript.push(
      { kind: 'user', text: 'Ship the fix from here', ts: userTs },
      { kind: 'message', text: 'Continuing in telecode', ts: messageTs },
    );
    rec.status = 'running';
    send('session.started', {}, sid);
    send('agent.message', { text: 'Continuing in telecode', ts: messageTs }, sid);
    return;
  }

  if (envelope.type === 'session.launch') {
    const launch = sessionLaunchPayloadSchema.safeParse(envelope.payload);
    const rec = recordFor(sid);
    if (launch.success) rec.transcript.push({ kind: 'user', text: launch.data.prompt });
    rec.status = 'running';
    const clientRef = launch.success ? launch.data.clientRef : undefined;
    send('session.started', clientRef !== undefined ? { clientRef } : {}, sid);
    // Session identity (ux Phase 6): the real daemon derives a title from the first prompt and emits
    // sealed metadata; this cleartext fake mirrors the shape so specs can assert titles after reloads.
    if (launch.success) {
      send('session.meta', { title: launch.data.prompt, titleSource: 'derived' }, sid);
    }

    if (launch.success && launch.data.prompt.startsWith(TURN_LIMIT_PROMPT)) {
      // The run stops early on its turn budget: NOT done, NOT an error — and a follow-up continues it.
      rec.transcript.push({ kind: 'message', text: 'Ran out of turns mid-task' });
      send('agent.message', { text: 'Ran out of turns mid-task' }, sid);
      rec.status = 'turn_limit';
      send('session.ended', { status: 'turn_limit' }, sid);
      return;
    }

    if (launch.success && launch.data.prompt === CHAIN_PROMPT) {
      // The trigger session's only job is to kick off the dance — end it and announce the parent.
      rec.transcript.push({ kind: 'message', text: 'Chaining a takeover' });
      send('agent.message', { text: 'Chaining a takeover' }, sid);
      rec.status = 'done';
      send('session.ended', { status: 'done' }, sid);
      send('session.adopted', { clientRef: CHAIN_PARENT_REF, title: CHAIN_PARENT_TITLE });
      return;
    }

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
    // interrupt | end: settle any pending gate and end the current turn (mirrors the daemon's stop-turn).
    const gate = rec.transcript.find((e) => e.kind === 'permission' && e.decision === 'pending');
    if (gate?.kind === 'permission') gate.decision = 'deny';
    rec.status = 'done';
    send('session.ended', { status: 'done' }, sid);
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

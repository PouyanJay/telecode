import {
  deriveSharedKey,
  exportContentKey,
  generateContentKey,
  importContentKey,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  makeEnvelope,
  openPayload,
  parseEnvelope,
  permissionDecisionPayloadSchema,
  sealPayload,
  sessionAdoptedPayloadSchema,
  sessionChainedPayloadSchema,
  sessionControlPayloadSchema,
  sessionLaunchPayloadSchema,
  sessionResumeNewPayloadSchema,
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
// The gate's rough ±lines (mockup §01-4), mirrored like the real daemon computes for Write/Edit.
const DEFAULT_DIFF_STAT = { added: 1, removed: 0 };

/**
 * Launch prompt that triggers the chained-thread dance (ux Phase 3): the daemon ends the trigger
 * session immediately, announces an adopted "terminal" session with a mirrored transcript, then
 * registers a telecode continuation chained to it — producing a real parent→child pair in the registry
 * so the e2e can assert the collapsed thread row, lineage strip, and takeover divider.
 */
const CHAIN_PROMPT = 'chain a takeover';
// Magic prompt: the run exhausts its turn budget (ux Phase 6 T2) — ends `turn_limit`, stays followable.
const TURN_LIMIT_PROMPT = 'hit the turn limit';
// Magic prompt: the daemon "loses" the conversation (ux Phase 6 T8) — ends `needs_restart`, so the
// session view offers resume-as-new and the spec can drive the forked continuation.
const LOSE_SESSION_PROMPT = 'lose this session';
const CHAIN_PARENT_REF = 'chain-parent';
const CHAIN_CHILD_REF = 'chain-child';
// Overridable so the spec can use a per-run unique title — earlier runs' chains persist in the
// registry, and a fixed title would make "exactly one thread row" impossible on a reused local DB.
const CHAIN_PARENT_TITLE = process.env.FAKE_CHAIN_TITLE ?? 'Fix the pairing bug';

/**
 * OPT-IN E2E mode (T9): with a private key in the env (and the matching public key registered at
 * pairing), this fake speaks the daemon side of the real crypto — unseals box-sealed launches,
 * mints + delivers per-session content keys, and opens content-key-sealed browser actions — so
 * E2E-gated flows (rename) can be driven end-to-end. Outbound frames stay cleartext (the browser
 * renders either); the sealed-outbound path is proven by the daemon package's own integration tests.
 */
const e2ePrivateKey = process.env.FAKE_PRIVATE_KEY;
const contentKeys = new Map<string, string>(); // sessionId -> base64 content key

async function sharedWith(browserPublicKeyB64: string): Promise<CryptoKey> {
  return deriveSharedKey(
    await importIdentityPrivateKey(e2ePrivateKey!),
    await importIdentityPublicKey(browserPublicKeyB64),
  );
}

/** Open a launch-style frame box-sealed to this daemon; cleartext channels pass through untouched. */
async function openInboundLaunch(envelope: Envelope): Promise<unknown> {
  if (
    e2ePrivateKey === undefined ||
    typeof envelope.payload !== 'string' ||
    envelope.sender_public_key === undefined
  ) {
    return envelope.payload;
  }
  return openPayload(
    { payload: envelope.payload, nonce: envelope.nonce },
    await sharedWith(envelope.sender_public_key),
  );
}

/** Open a browser action sealed under the session content key; cleartext passes through untouched. */
async function openSessionPayload(envelope: Envelope): Promise<unknown> {
  const key = envelope.session_id !== undefined ? contentKeys.get(envelope.session_id) : undefined;
  if (key === undefined || typeof envelope.payload !== 'string' || envelope.nonce === '') {
    return envelope.payload;
  }
  return openPayload(
    { payload: envelope.payload, nonce: envelope.nonce },
    await importContentKey(key, false),
  );
}

/** Mint (once) + deliver the session's content key, box-sealed to the announcing browser's pubkey. */
async function deliverContentKey(sessionId: string, browserPublicKeyB64: string): Promise<void> {
  if (e2ePrivateKey === undefined) return;
  let key = contentKeys.get(sessionId);
  if (key === undefined) {
    key = await exportContentKey(await generateContentKey(true));
    contentKeys.set(sessionId, key);
  }
  const sealed = await sealPayload({ key }, await sharedWith(browserPublicKeyB64));
  // The one sealed outbound frame this fake sends — built directly (the shared `send` is cleartext-only).
  socket.send(
    JSON.stringify(
      makeEnvelope({
        type: 'session.key',
        userId,
        deviceId,
        sessionId,
        payload: sealed.payload,
        nonce: sealed.nonce,
      }),
    ),
  );
}

const socket = new WebSocket(relayUrl);
let requestSeq = 0;

interface SessionRecord {
  status: SessionStatusName;
  transcript: SessionHistoryEntry[];
}
const records = new Map<string, SessionRecord>();
// Resume-as-new continuations awaiting their relay `session.chained` ACK, by announce clientRef (T8).
const pendingResumes = new Map<string, { prompt: string; browserRef?: string }>();

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

// Frames are handled in order through a chain (decryption is async), mirroring the real daemon.
let inbound: Promise<void> = Promise.resolve();
socket.addEventListener('message', (event: MessageEvent) => {
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(JSON.parse(String(event.data)));
  } catch {
    return;
  }
  inbound = inbound
    .then(() => handleEnvelope(envelope))
    // Never wedge the chain — but a crypto/handler failure must reach stdout for log triangulation.
    .catch((err: unknown) => console.error('fake-daemon: frame handling failed', err));
});

async function handleEnvelope(envelope: Envelope): Promise<void> {
  if (envelope.type === 'hello.ack') {
    if (adoptAnnounceTitle !== undefined) {
      send('session.adopted', { clientRef: ADOPT_ANNOUNCE_REF, title: adoptAnnounceTitle });
    }
    console.log('fake-daemon: ready');
    return;
  }

  // The sealed local-branch round-trip (Phase B) — cleartext in this fake's default mode, exactly
  // like its other frames; the sealed path is proven by the daemon package's own crypto tests.
  if (envelope.type === 'repo.branches') {
    send('repo.branches.state', {
      available: true,
      branches: ['main', 'develop', 'feat/existing'],
      defaultBranch: 'main',
    });
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
        diffStat: DEFAULT_DIFF_STAT,
        decision: 'pending',
      });
      rec.status = 'awaiting_input';
      send('agent.message', { text: 'About to write the change' }, sid);
      send(
        'agent.permission_request',
        { requestId, toolName: 'Write', input: DEFAULT_INPUT, diffStat: DEFAULT_DIFF_STAT },
        sid,
      );
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
    if (!ack.success) return;
    // A resume-as-new child (T8): run the prompt as its first turn and finish, echoing the browser's
    // clientRef on session.started so the acting tab can navigate (exactly like a launch).
    const pendingResume = pendingResumes.get(ack.data.clientRef);
    if (pendingResume !== undefined) {
      pendingResumes.delete(ack.data.clientRef);
      const rec = recordFor(sid);
      rec.transcript.push({ kind: 'user', text: pendingResume.prompt });
      rec.status = 'running';
      send(
        'session.started',
        pendingResume.browserRef !== undefined ? { clientRef: pendingResume.browserRef } : {},
        sid,
      );
      send('session.meta', { title: pendingResume.prompt, titleSource: 'derived' }, sid);
      rec.transcript.push({ kind: 'message', text: 'Picking up where we left off' });
      send('agent.message', { text: 'Picking up where we left off' }, sid);
      rec.status = 'done';
      send('session.ended', { status: 'done' }, sid);
      return;
    }
    if (ack.data.clientRef !== CHAIN_CHILD_REF) return;
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
    const launch = sessionLaunchPayloadSchema.safeParse(await openInboundLaunch(envelope));
    const rec = recordFor(sid);
    if (launch.success) rec.transcript.push({ kind: 'user', text: launch.data.prompt });
    rec.status = 'running';
    // E2E: the launching browser gets the session's content key BEFORE any frame it must pair on.
    if (envelope.sender_public_key !== undefined) {
      await deliverContentKey(sid, envelope.sender_public_key);
    }
    const clientRef = launch.success ? launch.data.clientRef : undefined;
    send('session.started', clientRef !== undefined ? { clientRef } : {}, sid);
    // Session identity (ux Phase 6): the real daemon derives a title from the first prompt and emits
    // sealed metadata; this cleartext fake mirrors the shape so specs can assert titles after reloads.
    if (launch.success) {
      // Branch mirrors the real daemon's worktree naming so specs can assert the header/rail rows.
      send(
        'session.meta',
        {
          title: launch.data.prompt,
          titleSource: 'derived',
          // Mirrors the real daemon: a chosen name wins, else the worktree auto-name.
          branch: launch.data.branchName ?? `telecode/${sid}`,
        },
        sid,
      );
    }

    if (launch.success && launch.data.prompt.startsWith(TURN_LIMIT_PROMPT)) {
      // The run stops early on its turn budget: NOT done, NOT an error — and a follow-up continues it.
      rec.transcript.push({ kind: 'message', text: 'Ran out of turns mid-task' });
      send('agent.message', { text: 'Ran out of turns mid-task' }, sid);
      rec.status = 'turn_limit';
      send('session.ended', { status: 'turn_limit' }, sid);
      return;
    }

    if (launch.success && launch.data.prompt.startsWith(LOSE_SESSION_PROMPT)) {
      // The daemon "lost" this conversation: the honest terminal state whose only way forward is a
      // forked continuation (resume-as-new, T8).
      rec.transcript.push({ kind: 'message', text: 'Connection to the conversation was lost' });
      send('agent.message', { text: 'Connection to the conversation was lost' }, sid);
      rec.status = 'needs_restart';
      send('session.ended', { status: 'needs_restart' }, sid);
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
      diffStat: DEFAULT_DIFF_STAT,
      decision: 'pending',
    });
    rec.status = 'awaiting_input';
    send(
      'agent.permission_request',
      { requestId, toolName: 'Write', input: DEFAULT_INPUT, diffStat: DEFAULT_DIFF_STAT },
      sid,
    );
    return;
  }

  // Resume-as-new (T8): mint a linked child via the chained dance; the ACK handler above runs it.
  if (envelope.type === 'session.resume_new') {
    const resume = sessionResumeNewPayloadSchema.safeParse(await openInboundLaunch(envelope));
    if (!resume.success) return;
    const ref = `resume-child-${++requestSeq}`;
    pendingResumes.set(ref, {
      prompt: resume.data.prompt,
      ...(resume.data.clientRef !== undefined ? { browserRef: resume.data.clientRef } : {}),
    });
    send('session.chained', { clientRef: ref, parentSessionId: sid });
    return;
  }

  if (envelope.type === 'permission.decision') {
    const decision = permissionDecisionPayloadSchema.safeParse(await openSessionPayload(envelope));
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
    const control = sessionControlPayloadSchema.safeParse(await openSessionPayload(envelope));
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
    // E2E: re-deliver the content key to the announcing browser first (idempotent, same key).
    const rec = records.get(sid);
    if (envelope.sender_public_key !== undefined && rec !== undefined) {
      await deliverContentKey(sid, envelope.sender_public_key);
    }
    send(
      'session.history',
      rec
        ? { status: rec.status, entries: rec.transcript }
        : { status: 'offline_paused', entries: [] },
      sid,
    );
  }
}

socket.addEventListener('error', () => {
  console.error('fake-daemon: socket error');
});

import { describe, expect, it } from 'vitest';

import {
  adoptConfigPayloadSchema,
  adoptStatePayloadSchema,
  agentHandoverPayloadSchema,
  agentMessagePayloadSchema,
  agentNoticePayloadSchema,
  agentPermissionRequestPayloadSchema,
  agentQuestionPayloadSchema,
  agentToolUsePayloadSchema,
  handoverAnswerPayloadSchema,
  permissionDecisionPayloadSchema,
  questionAnswerPayloadSchema,
  relayErrorPayloadSchema,
  sessionAdoptedPayloadSchema,
  sessionChainedPayloadSchema,
  sessionControlPayloadSchema,
  sessionHistoryPayloadSchema,
  sessionKeyPayloadSchema,
  sessionLaunchPayloadSchema,
  sessionOriginSchema,
  sessionReconcilePayloadSchema,
  userMessagePayloadSchema,
  viewerPresencePayloadSchema,
} from './session';

/**
 * The human-in-the-loop permission messages (Task 6). `agent.permission_request` (daemon → web) carries
 * a correlated `requestId` plus the tool the agent wants to run; `permission.decision` (web → daemon) is
 * the human's verdict, discriminated on `behavior` (allow / allow-with-edit / deny) and tied back by the
 * same `requestId`.
 */
describe('agentPermissionRequestPayloadSchema', () => {
  it('parses a tool request awaiting a decision', () => {
    const parsed = agentPermissionRequestPayloadSchema.parse({
      requestId: 'req_1',
      toolName: 'Write',
      input: { path: 'README.md', content: 'hi' },
    });
    expect(parsed.toolName).toBe('Write');
    expect(parsed.input).toEqual({ path: 'README.md', content: 'hi' });
  });

  it('rejects a request without a correlation id', () => {
    const result = agentPermissionRequestPayloadSchema.safeParse({
      requestId: '',
      toolName: 'Write',
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a request with no tool name', () => {
    const result = agentPermissionRequestPayloadSchema.safeParse({
      requestId: 'req_1',
      toolName: '',
      input: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('permissionDecisionPayloadSchema', () => {
  it('parses a plain allow', () => {
    const parsed = permissionDecisionPayloadSchema.parse({
      requestId: 'req_1',
      behavior: 'allow',
    });
    expect(parsed.behavior).toBe('allow');
    if (parsed.behavior === 'allow') {
      expect(parsed.updatedInput).toBeUndefined();
    }
  });

  it('parses an allow-with-edit carrying replacement input', () => {
    const parsed = permissionDecisionPayloadSchema.parse({
      requestId: 'req_1',
      behavior: 'allow',
      updatedInput: { path: 'SAFE.md', content: 'edited' },
    });
    if (parsed.behavior !== 'allow') throw new Error('expected allow');
    expect(parsed.updatedInput).toEqual({ path: 'SAFE.md', content: 'edited' });
  });

  it('parses a deny with a human-readable reason', () => {
    const parsed = permissionDecisionPayloadSchema.parse({
      requestId: 'req_1',
      behavior: 'deny',
      message: 'not allowed',
    });
    if (parsed.behavior !== 'deny') throw new Error('expected deny');
    expect(parsed.message).toBe('not allowed');
  });

  it('parses a deny without a reason (message optional)', () => {
    const parsed = permissionDecisionPayloadSchema.parse({ requestId: 'req_1', behavior: 'deny' });
    expect(parsed.behavior).toBe('deny');
  });

  it('rejects an unknown behavior', () => {
    const result = permissionDecisionPayloadSchema.safeParse({
      requestId: 'req_1',
      behavior: 'maybe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a decision without a correlation id', () => {
    const result = permissionDecisionPayloadSchema.safeParse({ behavior: 'allow' });
    expect(result.success).toBe(false);
  });
});

/**
 * The adopted-session question messages (Journey 2 / Phase 3). `agent.question` (daemon → web) mirrors the
 * Claude Code `AskUserQuestion` tool input (questions + options + per-question multiSelect) so the phone can
 * render the picker; `question.answer` (web → daemon) carries the human's pick(s) per question, which the
 * daemon relays back to the model as deny-feedback. "Other" is always implicitly allowed (Claude Code never
 * sends an `allowsOther` flag), so it is expressed purely as `otherText` on the answer — there is no flag.
 */
describe('agentQuestionPayloadSchema (adopted-session questions)', () => {
  const singleQuestion = {
    requestId: 'req_q1',
    questions: [
      {
        question: 'Which database should we use?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: 'Relational, strong consistency.' },
          { label: 'SQLite', description: 'Embedded, zero-config.' },
        ],
      },
    ],
  };

  it('parses a single-select question with options (mirrors the captured tool_input)', () => {
    const parsed = agentQuestionPayloadSchema.parse(singleQuestion);
    expect(parsed.requestId).toBe('req_q1');
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0]?.multiSelect).toBe(false);
    expect(parsed.questions[0]?.options.map((o) => o.label)).toEqual(['Postgres', 'SQLite']);
  });

  it('parses a multi-select question and a missing option description (version-drift safe)', () => {
    const parsed = agentQuestionPayloadSchema.parse({
      requestId: 'req_q2',
      questions: [
        {
          question: 'Pick the features to enable.',
          header: 'Features',
          multiSelect: true,
          options: [{ label: 'Auth' }, { label: 'Billing', description: 'Stripe.' }],
        },
      ],
    });
    expect(parsed.questions[0]?.multiSelect).toBe(true);
    expect(parsed.questions[0]?.options[0]?.description).toBeUndefined();
  });

  it('parses multiple questions in one AskUserQuestion call', () => {
    const parsed = agentQuestionPayloadSchema.parse({
      requestId: 'req_q3',
      questions: [
        { question: 'A?', header: 'A', multiSelect: false, options: [{ label: 'x' }] },
        {
          question: 'B?',
          header: 'B',
          multiSelect: true,
          options: [{ label: 'y' }, { label: 'z' }],
        },
      ],
    });
    expect(parsed.questions).toHaveLength(2);
  });

  it('rejects a question with no options or no questions at all', () => {
    expect(
      agentQuestionPayloadSchema.safeParse({
        requestId: 'r',
        questions: [{ question: 'q', header: 'h', multiSelect: false, options: [] }],
      }).success,
    ).toBe(false);
    expect(agentQuestionPayloadSchema.safeParse({ requestId: 'r', questions: [] }).success).toBe(
      false,
    );
  });

  it('rejects a question payload without a correlation id', () => {
    expect(
      agentQuestionPayloadSchema.safeParse({ requestId: '', questions: singleQuestion.questions })
        .success,
    ).toBe(false);
  });
});

describe('questionAnswerPayloadSchema (adopted-session answers)', () => {
  it('parses a single-select pick (one label)', () => {
    const parsed = questionAnswerPayloadSchema.parse({
      requestId: 'req_q1',
      answers: [{ selectedLabels: ['Postgres'] }],
    });
    expect(parsed.answers[0]?.selectedLabels).toEqual(['Postgres']);
    expect(parsed.answers[0]?.otherText).toBeUndefined();
  });

  it('parses a multi-select pick (several labels)', () => {
    const parsed = questionAnswerPayloadSchema.parse({
      requestId: 'req_q2',
      answers: [{ selectedLabels: ['Auth', 'Billing'] }],
    });
    expect(parsed.answers[0]?.selectedLabels).toEqual(['Auth', 'Billing']);
  });

  it('parses an "Other" free-text answer with no selected labels (selectedLabels defaults to [])', () => {
    const parsed = questionAnswerPayloadSchema.parse({
      requestId: 'req_q1',
      answers: [{ otherText: 'DuckDB, actually' }],
    });
    expect(parsed.answers[0]?.selectedLabels).toEqual([]);
    expect(parsed.answers[0]?.otherText).toBe('DuckDB, actually');
  });

  it('parses one answer per question for a multi-question call', () => {
    const parsed = questionAnswerPayloadSchema.parse({
      requestId: 'req_q3',
      answers: [{ selectedLabels: ['x'] }, { selectedLabels: ['y', 'z'] }],
    });
    expect(parsed.answers).toHaveLength(2);
  });

  it('rejects an empty answer (no selection and no otherText)', () => {
    expect(
      questionAnswerPayloadSchema.safeParse({ requestId: 'r', answers: [{ selectedLabels: [] }] })
        .success,
    ).toBe(false);
    expect(questionAnswerPayloadSchema.safeParse({ requestId: 'r', answers: [{}] }).success).toBe(
      false,
    );
  });

  it('rejects an answer payload without a correlation id or with no answers', () => {
    expect(
      questionAnswerPayloadSchema.safeParse({ requestId: '', answers: [{ selectedLabels: ['x'] }] })
        .success,
    ).toBe(false);
    expect(questionAnswerPayloadSchema.safeParse({ requestId: 'r', answers: [] }).success).toBe(
      false,
    );
  });
});

describe('adoptConfig / adoptState payload schemas (Journey 3)', () => {
  it('parses a SET (full config) and a GET (no set)', () => {
    const set = adoptConfigPayloadSchema.parse({
      set: { enabled: true, denylist: ['/Users/me/secret-repo'] },
    });
    expect(set.set?.enabled).toBe(true);
    expect(set.set?.denylist).toEqual(['/Users/me/secret-repo']);
    expect(adoptConfigPayloadSchema.parse({}).set).toBeUndefined();
  });

  it('rejects a config with a non-boolean enabled or a non-string denylist entry', () => {
    expect(
      adoptConfigPayloadSchema.safeParse({ set: { enabled: 'yes', denylist: [] } }).success,
    ).toBe(false);
    expect(
      adoptConfigPayloadSchema.safeParse({ set: { enabled: true, denylist: [42] } }).success,
    ).toBe(false);
    expect(
      adoptConfigPayloadSchema.safeParse({ set: { enabled: true, denylist: [''] } }).success,
    ).toBe(false);
  });

  it('parses the daemon state (enabled + denylist + hook install status)', () => {
    const state = adoptStatePayloadSchema.parse({
      enabled: true,
      denylist: ['/secret'],
      hooksInstalled: true,
      events: ['PreToolUse', 'Stop'],
    });
    expect(state.enabled).toBe(true);
    expect(state.denylist).toEqual(['/secret']);
    expect(state.hooksInstalled).toBe(true);
    expect(state.events).toEqual(['PreToolUse', 'Stop']);
  });

  it('defaults events to [] and requires hooksInstalled (the setup status the web renders)', () => {
    const state = adoptStatePayloadSchema.parse({
      enabled: true,
      denylist: [],
      hooksInstalled: false,
    });
    expect(state.events).toEqual([]);
    // hooksInstalled is required — the web must always know whether adoption is actually wired up.
    expect(adoptStatePayloadSchema.safeParse({ enabled: true, denylist: [] }).success).toBe(false);
  });
});

describe('agentNoticePayloadSchema (adopted-session notifications, Journey 3)', () => {
  it('parses a notification message', () => {
    const parsed = agentNoticePayloadSchema.parse({
      message: 'Claude is waiting for your input',
    });
    expect(parsed.message).toBe('Claude is waiting for your input');
  });

  it('rejects an empty message', () => {
    expect(agentNoticePayloadSchema.safeParse({ message: '' }).success).toBe(false);
    expect(agentNoticePayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('sessionLaunchPayloadSchema: repo selection (Task 8)', () => {
  it('parses a launch carrying a repo to clone on demand', () => {
    const parsed = sessionLaunchPayloadSchema.parse({
      prompt: 'fix the bug',
      repo: {
        owner: 'octocat',
        name: 'hello-world',
        cloneUrl: 'https://github.com/octocat/hello-world.git',
      },
    });
    expect(parsed.repo).toEqual({
      owner: 'octocat',
      name: 'hello-world',
      cloneUrl: 'https://github.com/octocat/hello-world.git',
    });
  });

  it('parses a launch with no repo (repo is optional)', () => {
    const parsed = sessionLaunchPayloadSchema.parse({ prompt: 'just chat' });
    expect(parsed.repo).toBeUndefined();
  });

  it('rejects a repo whose owner/name is not a safe path segment', () => {
    for (const segment of ['..', '.', 'has/slash', 'bad space', '']) {
      expect(
        sessionLaunchPayloadSchema.safeParse({
          prompt: 'x',
          repo: { owner: segment, name: 'ok', cloneUrl: 'https://example.com/r.git' },
        }).success,
        `owner ${JSON.stringify(segment)} must be rejected`,
      ).toBe(false);
      expect(
        sessionLaunchPayloadSchema.safeParse({
          prompt: 'x',
          repo: { owner: 'ok', name: segment, cloneUrl: 'https://example.com/r.git' },
        }).success,
        `name ${JSON.stringify(segment)} must be rejected`,
      ).toBe(false);
    }
  });

  it('rejects a repo with an empty clone url', () => {
    expect(
      sessionLaunchPayloadSchema.safeParse({
        prompt: 'x',
        repo: { owner: 'ok', name: 'ok', cloneUrl: '' },
      }).success,
    ).toBe(false);
  });
});

describe('sessionControlPayloadSchema: per-session controls (Task 9)', () => {
  it('parses each control action', () => {
    for (const action of ['end', 'interrupt'] as const) {
      expect(sessionControlPayloadSchema.parse({ action }).action).toBe(action);
    }
  });

  it('rejects an unknown control action (pause/resume were removed)', () => {
    expect(sessionControlPayloadSchema.safeParse({ action: 'pause' }).success).toBe(false);
    expect(sessionControlPayloadSchema.safeParse({ action: 'resume' }).success).toBe(false);
    expect(sessionControlPayloadSchema.safeParse({ action: 'restart' }).success).toBe(false);
    expect(sessionControlPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('userMessagePayloadSchema', () => {
  it('parses a follow-up instruction', () => {
    expect(userMessagePayloadSchema.parse({ text: 'now add tests' }).text).toBe('now add tests');
  });

  it('rejects an empty follow-up', () => {
    expect(userMessagePayloadSchema.safeParse({ text: '' }).success).toBe(false);
  });
});

describe('sessionHistoryPayloadSchema', () => {
  it('parses a backfilled transcript of mixed entry kinds + status', () => {
    const parsed = sessionHistoryPayloadSchema.parse({
      status: 'awaiting_input',
      entries: [
        { kind: 'user', text: 'do it' },
        { kind: 'message', text: 'working' },
        { kind: 'tool', toolName: 'Read', input: { path: 'README.md' } },
        { kind: 'permission', requestId: 'req_1', toolName: 'Write', input: {}, decision: 'allow' },
      ],
    });
    expect(parsed.status).toBe('awaiting_input');
    expect(parsed.entries).toHaveLength(4);
  });

  it('parses a question entry — pending (no answers) and answered (answers present)', () => {
    const question = {
      question: 'Which DB?',
      header: 'DB',
      multiSelect: false,
      options: [{ label: 'Postgres' }],
    };
    const parsed = sessionHistoryPayloadSchema.parse({
      status: 'awaiting_input',
      entries: [
        { kind: 'question', requestId: 'q1', questions: [question] },
        {
          kind: 'question',
          requestId: 'q2',
          questions: [question],
          answers: [{ selectedLabels: ['Postgres'] }],
        },
      ],
    });
    expect(parsed.entries).toHaveLength(2);
    const [pending, answered] = parsed.entries;
    if (pending?.kind !== 'question' || answered?.kind !== 'question') {
      throw new Error('expected question entries');
    }
    expect(pending.answers).toBeUndefined();
    expect(answered.answers?.[0]?.selectedLabels).toEqual(['Postgres']);
  });

  it('accepts an empty transcript (a not-live session)', () => {
    expect(
      sessionHistoryPayloadSchema.safeParse({ status: 'offline_paused', entries: [] }).success,
    ).toBe(true);
  });

  it('rejects a permission entry with an unknown decision', () => {
    const result = sessionHistoryPayloadSchema.safeParse({
      status: 'running',
      entries: [
        { kind: 'permission', requestId: 'r', toolName: 'X', input: {}, decision: 'maybe' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entry with an unknown kind', () => {
    const result = sessionHistoryPayloadSchema.safeParse({
      status: 'running',
      entries: [{ kind: 'diff', text: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('per-entry timestamps (Phase 3 threads & lineage)', () => {
  const TS = 1_783_290_000_000; // an arbitrary daemon-stamped epoch-ms instant

  it('live entry-producing payloads carry an optional daemon-stamped ts (epoch ms)', () => {
    expect(agentMessagePayloadSchema.parse({ text: 'hi', ts: TS }).ts).toBe(TS);
    expect(agentToolUsePayloadSchema.parse({ toolName: 'Read', input: {}, ts: TS }).ts).toBe(TS);
    expect(
      agentPermissionRequestPayloadSchema.parse({
        requestId: 'r1',
        toolName: 'Write',
        input: {},
        ts: TS,
      }).ts,
    ).toBe(TS);
    expect(
      agentQuestionPayloadSchema.parse({
        requestId: 'q1',
        questions: [
          { question: 'Which?', header: 'DB', multiSelect: false, options: [{ label: 'pg' }] },
        ],
        ts: TS,
      }).ts,
    ).toBe(TS);
    expect(
      agentHandoverPayloadSchema.parse({ requestId: 'h1', question: 'ok?', summary: '', ts: TS })
        .ts,
    ).toBe(TS);
  });

  it('ts is optional everywhere — an old daemon that stamps nothing still parses', () => {
    expect(agentMessagePayloadSchema.parse({ text: 'hi' }).ts).toBeUndefined();
    const history = sessionHistoryPayloadSchema.parse({
      status: 'running',
      entries: [{ kind: 'message', text: 'no stamp' }],
    });
    expect(history.entries[0]?.ts).toBeUndefined();
  });

  it('every history entry kind carries ts through a backfill round-trip', () => {
    const entries = [
      { kind: 'user', text: 'do it', ts: TS },
      { kind: 'message', text: 'working', ts: TS + 1 },
      { kind: 'tool', toolName: 'Read', input: {}, ts: TS + 2 },
      {
        kind: 'permission',
        requestId: 'r1',
        toolName: 'Write',
        input: {},
        decision: 'allow',
        ts: TS + 3,
      },
      {
        kind: 'question',
        requestId: 'q1',
        questions: [
          { question: 'Which?', header: 'DB', multiSelect: false, options: [{ label: 'pg' }] },
        ],
        ts: TS + 4,
      },
      { kind: 'handover', requestId: 'h1', question: 'ok?', summary: '', ts: TS + 5 },
    ];
    const parsed = sessionHistoryPayloadSchema.parse({ status: 'running', entries });
    expect(parsed.entries.map((entry) => entry.ts)).toEqual([
      TS,
      TS + 1,
      TS + 2,
      TS + 3,
      TS + 4,
      TS + 5,
    ]);
  });

  it('rejects a non-integer or negative ts (a stamp is a whole epoch-ms instant)', () => {
    expect(agentMessagePayloadSchema.safeParse({ text: 'x', ts: 1.5 }).success).toBe(false);
    expect(agentMessagePayloadSchema.safeParse({ text: 'x', ts: -1 }).success).toBe(false);
    expect(
      sessionHistoryPayloadSchema.safeParse({
        status: 'running',
        entries: [{ kind: 'message', text: 'x', ts: 'yesterday' }],
      }).success,
    ).toBe(false);
  });
});

describe('sessionOriginSchema (adopted sessions)', () => {
  it('parses the two origins', () => {
    for (const origin of ['launched', 'external'] as const) {
      expect(sessionOriginSchema.parse(origin)).toBe(origin);
    }
  });

  it('rejects an unknown origin', () => {
    expect(sessionOriginSchema.safeParse('imported').success).toBe(false);
  });
});

describe('sessionAdoptedPayloadSchema (adopted sessions)', () => {
  it('parses a daemon adoption announce with a derived title + cwd', () => {
    const parsed = sessionAdoptedPayloadSchema.parse({
      clientRef: 'claude-abc123',
      title: 'fix the bug',
      cwd: '/Users/me/repo',
    });
    expect(parsed.clientRef).toBe('claude-abc123');
    expect(parsed.title).toBe('fix the bug');
    expect(parsed.cwd).toBe('/Users/me/repo');
  });

  it('parses with only the required clientRef (title/cwd optional)', () => {
    const parsed = sessionAdoptedPayloadSchema.parse({ clientRef: 'c1' });
    expect(parsed.title).toBeUndefined();
    expect(parsed.cwd).toBeUndefined();
  });

  it('rejects an announce without a clientRef (the daemon↔id correlation)', () => {
    expect(sessionAdoptedPayloadSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(sessionAdoptedPayloadSchema.safeParse({ clientRef: '' }).success).toBe(false);
  });
});

/**
 * The free-form handover messages (Journey 4 / Tier 4). When an adopted session ends its turn asking a
 * free-form question, telecode offers to take it over by resuming the conversation under its own control.
 * `agent.handover` (daemon → web) is a NON-blocking offer carrying the exact question + a handover summary;
 * `handover.answer` (web → daemon) carries the user's answer, which triggers a forked telecode-owned
 * continuation; `session.chained` (daemon → relay → browser) registers that continuation linked to the
 * adopted row via `parentSessionId`.
 */
describe('agentHandoverPayloadSchema (free-form handover offer)', () => {
  it('parses an offer carrying the exact question and a summary', () => {
    const parsed = agentHandoverPayloadSchema.parse({
      requestId: 'h1',
      question: 'Which database should we use for the app?',
      summary: 'The session was scaffolding a new API and asked about storage.',
    });
    expect(parsed.requestId).toBe('h1');
    expect(parsed.question).toContain('database');
  });

  it('accepts an empty summary (deterministic extraction may find little context)', () => {
    expect(
      agentHandoverPayloadSchema.parse({ requestId: 'h1', question: 'Ready?', summary: '' })
        .summary,
    ).toBe('');
  });

  it('rejects a missing correlation id or an empty question', () => {
    expect(
      agentHandoverPayloadSchema.safeParse({ requestId: '', question: 'q', summary: '' }).success,
    ).toBe(false);
    expect(
      agentHandoverPayloadSchema.safeParse({ requestId: 'h1', question: '', summary: '' }).success,
    ).toBe(false);
  });
});

describe('handoverAnswerPayloadSchema (the user takes over remotely)', () => {
  it('parses the free-text answer that seeds the resumed turn', () => {
    const parsed = handoverAnswerPayloadSchema.parse({
      requestId: 'h1',
      answerText: 'Use Postgres.',
    });
    expect(parsed.answerText).toBe('Use Postgres.');
  });

  it('rejects an empty answer or a missing correlation id', () => {
    expect(handoverAnswerPayloadSchema.safeParse({ requestId: 'h1', answerText: '' }).success).toBe(
      false,
    );
    expect(handoverAnswerPayloadSchema.safeParse({ requestId: '', answerText: 'x' }).success).toBe(
      false,
    );
  });
});

describe('sessionChainedPayloadSchema (forked continuation registration)', () => {
  // parentSessionId is a relay-minted session id — validated as a UUID on the wire.
  const PARENT = '11111111-1111-1111-1111-111111111111';

  it('parses a child registration linked to its parent', () => {
    const parsed = sessionChainedPayloadSchema.parse({
      clientRef: 'fork-1',
      parentSessionId: PARENT,
      title: 'Continue: database choice',
      cwd: '/repo',
    });
    expect(parsed.parentSessionId).toBe(PARENT);
    expect(parsed.clientRef).toBe('fork-1');
  });

  it('rejects a parentSessionId that is not a UUID', () => {
    expect(
      sessionChainedPayloadSchema.safeParse({ clientRef: 'fork-1', parentSessionId: 'p' }).success,
    ).toBe(false);
  });

  it('requires both the correlation ref and the parent link (title/cwd optional)', () => {
    const parsed = sessionChainedPayloadSchema.parse({
      clientRef: 'fork-1',
      parentSessionId: PARENT,
    });
    expect(parsed.title).toBeUndefined();
    expect(sessionChainedPayloadSchema.safeParse({ clientRef: 'fork-1' }).success).toBe(false);
    expect(sessionChainedPayloadSchema.safeParse({ parentSessionId: PARENT }).success).toBe(false);
    expect(
      sessionChainedPayloadSchema.safeParse({ clientRef: '', parentSessionId: PARENT }).success,
    ).toBe(false);
  });
});

describe('sessionHistoryPayloadSchema — handover entry (Journey 4)', () => {
  it('backfills a pending handover offer (question + summary, no answer yet)', () => {
    const parsed = sessionHistoryPayloadSchema.parse({
      status: 'awaiting_input',
      entries: [
        { kind: 'handover', requestId: 'h1', question: 'Which DB?', summary: 'scaffolding an API' },
      ],
    });
    expect(parsed.entries[0]).toMatchObject({ kind: 'handover', requestId: 'h1' });
  });

  it('backfills an answered handover (carries the answerText for the resolved state)', () => {
    const parsed = sessionHistoryPayloadSchema.parse({
      status: 'done',
      entries: [
        {
          kind: 'handover',
          requestId: 'h1',
          question: 'Which DB?',
          summary: '',
          answerText: 'Postgres',
        },
      ],
    });
    expect(parsed.entries[0]).toMatchObject({ answerText: 'Postgres' });
  });
});

describe('sessionKeyPayloadSchema', () => {
  // A well-formed base64 32-byte content key (43 base64 chars + one `=` pad).
  const VALID_KEY = `${'A'.repeat(43)}=`;

  it('validates the wrapped per-session content key (base64 32-byte key)', () => {
    expect(sessionKeyPayloadSchema.parse({ key: VALID_KEY }).key).toBe(VALID_KEY);
  });

  it('rejects a key that is not a base64 32-byte key', () => {
    for (const bad of ['', 'YmFzZTY0a2V5', `${'A'.repeat(44)}`]) {
      expect(sessionKeyPayloadSchema.safeParse({ key: bad }).success).toBe(false);
    }
  });

  it('rejects a missing key', () => {
    expect(sessionKeyPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('viewerPresencePayloadSchema (relay → daemon viewer presence)', () => {
  it('validates the online boolean either way', () => {
    expect(viewerPresencePayloadSchema.parse({ online: true })).toEqual({ online: true });
    expect(viewerPresencePayloadSchema.parse({ online: false })).toEqual({ online: false });
  });

  it('rejects a missing or non-boolean online', () => {
    expect(viewerPresencePayloadSchema.safeParse({}).success).toBe(false);
    expect(viewerPresencePayloadSchema.safeParse({ online: 'yes' }).success).toBe(false);
  });
});

describe('relayErrorPayloadSchema (relay → web delivery failure)', () => {
  it('accepts a delivery failure with a known code and the failed type', () => {
    const parsed = relayErrorPayloadSchema.parse({
      code: 'device_offline',
      regarding: 'permission.decision',
    });
    expect(parsed).toEqual({ code: 'device_offline', regarding: 'permission.decision' });
  });

  it('rejects an unknown code, a missing regarding, and an empty regarding', () => {
    expect(relayErrorPayloadSchema.safeParse({ code: 'nope', regarding: 'x' }).success).toBe(false);
    expect(relayErrorPayloadSchema.safeParse({ code: 'device_offline' }).success).toBe(false);
    expect(
      relayErrorPayloadSchema.safeParse({ code: 'device_offline', regarding: '' }).success,
    ).toBe(false);
  });
});

describe('sessionReconcilePayloadSchema (daemon → relay reconciliation)', () => {
  it('validates a list of held session ids (including empty — the daemon holds nothing)', () => {
    expect(sessionReconcilePayloadSchema.parse({ heldSessionIds: ['a', 'b'] })).toEqual({
      heldSessionIds: ['a', 'b'],
    });
    expect(sessionReconcilePayloadSchema.parse({ heldSessionIds: [] })).toEqual({
      heldSessionIds: [],
    });
  });

  it('rejects a missing list or non-string / empty-string ids', () => {
    expect(sessionReconcilePayloadSchema.safeParse({}).success).toBe(false);
    expect(sessionReconcilePayloadSchema.safeParse({ heldSessionIds: [1, 2] }).success).toBe(false);
    expect(sessionReconcilePayloadSchema.safeParse({ heldSessionIds: [''] }).success).toBe(false);
  });

  it('accepts a large list — a busy daemon can hold many sessions (no upper bound)', () => {
    const many = Array.from({ length: 500 }, (_, i) => `s${i}`);
    expect(
      sessionReconcilePayloadSchema.parse({ heldSessionIds: many }).heldSessionIds,
    ).toHaveLength(500);
  });
});

import { describe, expect, it } from 'vitest';

import {
  adoptConfigPayloadSchema,
  adoptStatePayloadSchema,
  agentNoticePayloadSchema,
  agentPermissionRequestPayloadSchema,
  agentQuestionPayloadSchema,
  permissionDecisionPayloadSchema,
  questionAnswerPayloadSchema,
  sessionAdoptedPayloadSchema,
  sessionControlPayloadSchema,
  sessionHistoryPayloadSchema,
  sessionKeyPayloadSchema,
  sessionLaunchPayloadSchema,
  sessionOriginSchema,
  userMessagePayloadSchema,
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

  it('parses the daemon state (current enabled + denylist)', () => {
    const state = adoptStatePayloadSchema.parse({ enabled: false, denylist: [] });
    expect(state.enabled).toBe(false);
    expect(state.denylist).toEqual([]);
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

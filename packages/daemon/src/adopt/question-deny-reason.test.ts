import { type AgentQuestionItem } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { buildQuestionDenyReason } from './question-deny-reason';

const dbQuestion: AgentQuestionItem = {
  question: 'Which database should we use?',
  header: 'Database',
  multiSelect: false,
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
};

/**
 * The deny-feedback reason carried back to the model. It must read as a relayed user answer (AD-4): a clear
 * telecode prefix, the chosen option(s) per question, and a gentle "proceed" — never an out-of-band command.
 */
describe('buildQuestionDenyReason', () => {
  it('frames a single-select pick as a relayed answer to that question', () => {
    const reason = buildQuestionDenyReason([dbQuestion], [{ selectedLabels: ['Postgres'] }]);
    expect(reason).toContain('[Answer relayed from the user via telecode]');
    expect(reason).toContain('"Database": Postgres');
    expect(reason).toContain('Proceed using these answers');
  });

  it('joins multiple selected labels for a multi-select answer', () => {
    const features: AgentQuestionItem = {
      question: 'Pick features',
      header: 'Features',
      multiSelect: true,
      options: [{ label: 'Auth' }, { label: 'Billing' }],
    };
    const reason = buildQuestionDenyReason([features], [{ selectedLabels: ['Auth', 'Billing'] }]);
    expect(reason).toContain('"Features": Auth, Billing');
  });

  it('includes "Other" free text alongside (or instead of) selected labels', () => {
    const reason = buildQuestionDenyReason(
      [dbQuestion],
      [{ selectedLabels: [], otherText: 'DuckDB, actually' }],
    );
    expect(reason).toContain('"Database": DuckDB, actually');
  });

  it('lists one line per question for a multi-question call', () => {
    const q2: AgentQuestionItem = {
      question: 'Region?',
      header: 'Region',
      multiSelect: false,
      options: [{ label: 'EU' }, { label: 'US' }],
    };
    const reason = buildQuestionDenyReason(
      [dbQuestion, q2],
      [{ selectedLabels: ['Postgres'] }, { selectedLabels: ['EU'] }],
    );
    expect(reason).toContain('"Database": Postgres');
    expect(reason).toContain('"Region": EU');
  });
});

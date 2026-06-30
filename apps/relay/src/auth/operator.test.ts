import { describe, expect, it } from 'vitest';

import { isOperator } from './operator';

const OPERATORS = ['op@telecode.io', 'Owner@Example.com'];

describe('isOperator', () => {
  it('admits an email on the allowlist', () => {
    expect(isOperator('op@telecode.io', OPERATORS)).toBe(true);
  });

  it('matches the candidate email case-insensitively', () => {
    expect(isOperator('OWNER@example.com', OPERATORS)).toBe(true);
  });

  it('trims surrounding whitespace from the candidate email', () => {
    expect(isOperator('  op@telecode.io  ', OPERATORS)).toBe(true);
  });

  it('trims whitespace from allowlist entries when comparing', () => {
    expect(isOperator('owner@example.com', ['  Owner@Example.com '])).toBe(true);
  });

  it('rejects an email not on the allowlist', () => {
    expect(isOperator('someone@else.com', OPERATORS)).toBe(false);
  });

  it('fails safe for null/undefined/empty email or an empty allowlist', () => {
    expect(isOperator(null, OPERATORS)).toBe(false);
    expect(isOperator(undefined, OPERATORS)).toBe(false);
    expect(isOperator('', OPERATORS)).toBe(false);
    expect(isOperator('   ', OPERATORS)).toBe(false);
    expect(isOperator('op@telecode.io', [])).toBe(false);
  });
});

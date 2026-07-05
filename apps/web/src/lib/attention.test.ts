import { describe, expect, it } from 'vitest';

import { withAttentionCount } from './attention';

/**
 * Tab-title attention badge (approval-reliability T7): a "(N) " prefix on the document title while N
 * sessions await a decision, so a backgrounded tab still signals. Idempotent — re-applying never
 * stacks prefixes, and navigation-set titles get the prefix re-applied cleanly.
 */
describe('withAttentionCount', () => {
  it('prefixes the pending count', () => {
    expect(withAttentionCount('Sessions · telecode', 2)).toBe('(2) Sessions · telecode');
  });

  it('strips a stale prefix before applying the fresh one (never stacks)', () => {
    expect(withAttentionCount('(5) Sessions · telecode', 2)).toBe('(2) Sessions · telecode');
  });

  it('removes the prefix entirely when nothing is pending', () => {
    expect(withAttentionCount('(3) Sessions · telecode', 0)).toBe('Sessions · telecode');
    expect(withAttentionCount('Sessions · telecode', 0)).toBe('Sessions · telecode');
  });

  it('leaves a title whose real content starts with parentheses alone when not a badge', () => {
    // Only a leading "(<digits>) " is treated as a badge.
    expect(withAttentionCount('(draft) notes · telecode', 1)).toBe('(1) (draft) notes · telecode');
  });
});

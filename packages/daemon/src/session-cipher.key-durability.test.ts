import { encodeKey, generateKeyPair, importContentKey, openPayload } from '@telecode/protocol';
import { describe, expect, it } from 'vitest';

import { createSessionCipher } from './session-cipher';

/**
 * Content-key durability (session-identity T3), daemon leg. A restart must NOT rotate a session's
 * content key — a metadata/transcript blob the relay cached (or Postgres stored) under the old key
 * would otherwise become undecryptable. The cipher can EXPORT its content key (base64) for the session
 * store to persist, and RESTORE it on the next process so the same key encrypts and delivers.
 */
async function daemonCipher() {
  const kp = await generateKeyPair();
  return createSessionCipher(encodeKey(kp.privateKey));
}

describe('daemon SessionCipher key durability', () => {
  it('exports an established key and restores it into a fresh cipher (same key)', async () => {
    const first = await daemonCipher();
    first.establish('s1');
    const exported = await first.exportKey('s1');
    expect(exported).toEqual(expect.any(String));

    // A payload sealed by the first cipher must open under the restored key in a second cipher.
    const sealed = await first.encrypt('s1', { title: 'persisted run' });

    const second = await daemonCipher();
    expect(second.isEncrypted('s1')).toBe(false);
    second.restoreKey('s1', exported!);
    expect(second.isEncrypted('s1')).toBe(true);

    const opened = await openPayload(sealed, await importContentKey(exported!, false));
    expect(opened).toEqual({ title: 'persisted run' });
    // And the restored cipher itself encrypts under the same key (round-trips with the export).
    const sealedBySecond = await second.encrypt('s1', { title: 'again' });
    expect(await openPayload(sealedBySecond, await importContentKey(exported!, false))).toEqual({
      title: 'again',
    });
  });

  it('exportKey returns undefined for an unknown session', async () => {
    const cipher = await daemonCipher();
    expect(await cipher.exportKey('nope')).toBeUndefined();
  });

  it('restoreKey is idempotent and never clobbers an established key', async () => {
    const cipher = await daemonCipher();
    cipher.establish('s1');
    const original = await cipher.exportKey('s1');
    // A restore with a DIFFERENT key must not replace the one already in use.
    const other = await daemonCipher();
    other.establish('s1');
    const otherKey = await other.exportKey('s1');
    expect(otherKey).not.toBe(original);
    cipher.restoreKey('s1', otherKey!);
    expect(await cipher.exportKey('s1')).toBe(original);
  });
});

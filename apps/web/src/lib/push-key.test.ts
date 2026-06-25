import { describe, expect, it } from 'vitest';

import { urlBase64ToUint8Array } from './push-key';

describe('urlBase64ToUint8Array: decode a base64url VAPID key for pushManager.subscribe', () => {
  it('decodes a url-safe base64 string (no padding) to the right bytes', () => {
    // "AQIDBA" is base64url of [1,2,3,4]; the helper must pad it back to standard base64 before decoding.
    expect([...urlBase64ToUint8Array('AQIDBA')]).toEqual([1, 2, 3, 4]);
  });

  it('translates the url-safe alphabet (- and _ for + and /)', () => {
    // 0xFB 0xFF encodes to "+/8=" in standard base64 → "-_8" in base64url (the 0x3E/0x3F sextets).
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([0xfb, 0xff]);
  });

  it('decodes an application server key to a 65-byte P-256 public key', () => {
    const vapidPublicKey =
      'BAVCop33Xmk3KokPzKYBY0r7dqnBB5NrUsEnDjv5KNa4-m_jblNY4t6G0efMoWl-lMp0rfkdXL8CFT2foKVZzNs';
    expect(urlBase64ToUint8Array(vapidPublicKey)).toHaveLength(65);
  });
});

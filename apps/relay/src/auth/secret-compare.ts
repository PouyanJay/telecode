import { timingSafeEqual } from 'node:crypto';

/** Constant-time string equality for comparing secrets (length-safe; avoids timing side channels). */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

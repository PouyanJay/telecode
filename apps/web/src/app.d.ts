// See https://svelte.dev/docs/kit/types#app.d.ts
import type { RelayUser } from '$lib/server/relay-api';

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      user: RelayUser | null;
    }
    interface PageData {
      user?: RelayUser | null;
    }
    // interface Platform {}
  }
}

export {};

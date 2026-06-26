#!/usr/bin/env node
/**
 * `telecode` launcher (Phase 4 T13). The daemon ships as TypeScript and runs through tsx with no build
 * step — the same way the relay image runs — so this shim registers the tsx ESM loader, then hands off to
 * the daemon entry point. Everything (pairing, `telecode doctor`, the session loop) lives in `main.ts`.
 */
import { register } from 'tsx/esm/api';

register();
await import(new URL('../src/main.ts', import.meta.url).href);

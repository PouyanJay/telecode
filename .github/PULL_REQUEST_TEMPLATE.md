<!--
Thanks for contributing to telecode! Please fill this out so reviewers can move quickly.
For security issues, do NOT open a PR — see SECURITY.md.
-->

## What & why

<!-- What does this change do, and what problem does it solve? Link the issue it addresses. -->

Closes #

## How I verified it

<!-- The tests you added/ran and any manual verification. -->

## Checklist

- [ ] Tests added or updated, and they cover the change (test-first where practical)
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` pass
- [ ] `pnpm --filter web check` passes (for UI changes)
- [ ] `pnpm test` passes locally (the relay suite needs the local Postgres up)
- [ ] UI changes use design tokens/primitives and cover all states (loading/empty/error) + WCAG 2.2 AA
- [ ] No secrets, tokens, or plaintext session content added to code or logs
- [ ] Architecture invariants upheld (outbound-only relay, execution stays local, Agent SDK behind the
      adapter, approval gate intact, relay sees ciphertext only) — see CONTRIBUTING.md
- [ ] Docs updated if behavior or setup changed

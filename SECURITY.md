# Security Policy

telecode is a tool for running coding agents on your own machine, with an end-to-end-encrypted path
between your browser and that machine. We take its security seriously and appreciate responsible
disclosure.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull
requests.**

Instead, report privately through either channel:

- **GitHub private vulnerability reporting (preferred):** go to the repository's **Security** tab →
  **Report a vulnerability**. This opens a private advisory visible only to you and the maintainers.
- **Email:** `security@telecode.io`.

Please include, as far as you can:

- the component affected (web, relay, daemon, protocol/crypto),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested remediation.

We will acknowledge your report within **5 business days**, keep you updated on our assessment and a fix
timeline, and credit you in the advisory once a fix ships (unless you prefer to remain anonymous).

## Scope

Most relevant to telecode's trust model:

- Anything that lets the **relay read plaintext** session content (it must only ever see ciphertext plus
  routing metadata).
- Bypassing the **approval gate** so a tool call runs on a user's machine without a human decision.
- **Authentication / authorization** flaws in pairing, device tokens, channel tokens, or session access.
- Letting one user **read or control another user's** devices or sessions.
- **Secret or key material exposure** (in logs, storage, or over the wire).

Out of scope: issues that require a fully compromised user machine, social-engineering attacks, and
volumetric DoS against a relay you do not operate (self-host for full control — see
[`docs/self-hosting.md`](./docs/self-hosting.md)).

## Supported versions

telecode is pre-1.0 and ships from `main`. Security fixes land on `main` and in the latest release; please
test against the latest before reporting.

## Learn more

The [threat model](./docs/threat-model.md) documents exactly what each component can and cannot see,
including the honest caveat about relay-visible routing metadata, and how to verify the relay only handles
ciphertext.

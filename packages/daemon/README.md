# @telecode/cli

The telecode daemon: pairs your machine with [telecode](https://telecode.io) so you can launch,
monitor, and steer Claude Code agents running on it — from any browser, end-to-end encrypted.
Execution stays on your machine; the relay only ever sees ciphertext.

```sh
npm install -g @telecode/cli
telecode          # pair this machine, then control it from any browser
telecode doctor   # preflight: Node, API key, pairing, relay reachability
telecode service install   # run it as a background (login) service
```

Requires Node ≥ 22.

## Upgrading — self-hosted relays

**Upgrade your relay before (or together with) the daemon.** New daemon releases can emit wire
messages and session statuses an older relay drops whole — for example, a session ending on its turn
budget would never be recorded as ended, leaving it stuck "running" in the dashboard until the next
reconcile. The hosted relay is always current; this only concerns self-hosted deployments.

## License

AGPL-3.0-only. Source: <https://github.com/PouyanJay/telecode>.

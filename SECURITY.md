# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues, pull requests or discussions.

Open a [private security advisory](https://github.com/probablysamir/drawa/security/advisories/new) instead. Include what's affected, how to reproduce it, and what an attacker could do with it. The maintainers will reply in the advisory and can credit you in it when the fix is released, unless you'd rather stay anonymous.

## Supported versions

Fixes go into the next release. Only the [latest release](https://github.com/probablysamir/drawa/releases/latest) and `main` are supported.

## Scope

Drawa is built to run locally for one user. These are the protections it relies on, so a way around any of them is in scope:

- The server listens on `127.0.0.1` only unless started with `--net`, and checks the `Host` header on every request.
- With `--net`, a network address needs the one-time `?token=`, and repeated wrong guesses lock that address out.
- Changing requests must come from Drawa's own page (a matching `Origin`).
- File access is confined to the project folder that was opened.
- Claude's canvas tools use a per-process token, so only that session's own `claude` process can call them.
- `drawa --update` refuses a release binary whose sha256 doesn't match the release's `checksums.txt`. `install.sh` checks it too, but skips the check (with a warning) when the machine has no `sha256sum`/`shasum` or the release has no `checksums.txt`.

Out of scope: what Claude Code itself does with the permissions you grant it, and anyone who already has access to your machine or to a `--net` link you shared.

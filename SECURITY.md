# Security Policy

Autorotate exists to rotate secrets safely; we hold this repository to the same
standard.

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use **GitHub's private vulnerability reporting:** https://github.com/jaywedgeworth22/Autorotate/security/advisories/new

Include:

- a description of the vulnerability and affected module(s)
  (`apps/web`, `apple/AutorotateCore`, `apple/Autorotate-iOS`, `apple/Autorotate-macOS`);
- steps to reproduce or a proof of concept;
- any suggested remediation.

We aim to acknowledge reports within 72 hours and coordinate disclosure with
the reporter.  Please give us reasonable time to ship a fix before public
disclosure.

## Credential storage boundaries

Keep secret material out of logs, crash reports, analytics, error messages,
and git history.  Store application-managed credentials encrypted at rest
or in the platform credential store; web database credentials are encrypted
with `AUTOROTATE_ENC_KEY`.

Configured file targets are an intentional exception: they write a credential
to the destination the operator selects.  Preserve the target's access
permissions, protect backups, and clean up temporary files used during
replacement.  This exception does not permit diagnostic dumps or unrelated
plaintext copies.

Minimize the time secrets remain in memory and avoid unnecessary copies.
Changes must preserve these boundaries and the append-only audit history.

## Credential handling rules

- Use `apps/web/.env.example` placeholders locally; real values go only in
  untracked `.env` files.
- Never hard-code tokens, connection strings, or encryption keys in source.
- On Apple platforms, application-managed credentials belong in the Keychain
  (shared access group `codes.autorotate.shared`), not `UserDefaults`.  Explicitly
  configured file targets remain subject to the file-handling rules above.
- Webhook targets must use HTTPS; never disable certificate validation.
- Rotate any credential immediately if you suspect it entered logs, git
  history, or a ticket.

## Audit chain

Rotation audit records are append-only and hash-chained to make history
tamper-evident.  Code must never update or delete existing audit entries;
corrections are new appended records.

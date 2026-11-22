# Coding Standards

Judgement-call engineering standards for human and agent code reviews (`/code-review`). Mechanical rules already enforced by ESLint, `eslint-plugin-obsidianmd`, TypeScript strict mode, and `scripts/check-release-gate.mjs` are intentionally omitted here.

## 1. Deep Modules and Clean Seams

- **Favour deep modules over shallow pass-throughs**: Expose narrow interfaces (`DaemonClient`, `SpeechPlayer`, `SentenceSegmenter`) that hide protocol framing, timeout budgets, health probing, and fallback state machines from callers.
- **Place seams only where behaviour genuinely varies**: Introduce an interface or adapter seam when at least two concrete adapters cross it (for example, local WASM, loopback daemon, and cloud BYOK transports, or real network vs test fakes). Delete single-implementation wrappers.
- **Accept dependencies at the seam**: Pass `fetchImpl`, secret providers, and fallback adapters into constructors or options instead of reaching for ambient singletons so tests exercise the public interface directly.

## 2. Single Source of Truth and Reuse

- **Reuse workspace modules before writing new helpers**: Check `@voice-mode/core` and `@voice-mode/browser` first. Shared logic (WAV framing, RFC 7578 multipart encoding, audio MIME sniffing, emotion parsing, focus text injection, secret redaction) lives once in the lowest host-agnostic package.
- **Keep domain terminology aligned with `GLOSSARY.md`**: Name types, options, and test cases after canonical glossary terms (*Utterance*, *Endpoint Policy*, *Barge-In*, *Replacement Rule*, *Emotion Tag*, *Voice Preset*, *Secret ID*, *External Model Cache*, *Voice Daemon*, *Host Degradation*).
- **Zero speculative configuration**: Standard library and platform Web APIs come before custom abstractions; zero runtime npm dependencies in `@voice-mode/core` and `@voice-mode/browser`. Respect hard module budgets (`llm-router.ts < 400` lines, `main.js < 1 MB`).

## 3. Security and Credential Hygiene

- **Redact before truncating**: Any error path that formats HTTP bodies, headers, URLs, or exception messages must pass the full bounded buffer through `redactSecrets` *before* slicing to a display length so credentials straddling the cut boundary cannot leak.
- **Reference credentials only by Secret ID**: Settings state and serialized snapshots may hold validated Secret IDs (`/^[a-z0-9-]+$/`), never raw API keys, Bearer tokens, or high-entropy hex tokens. Strip suspected raw secrets on load and save.
- **Fail closed on transport boundaries**: Enforce HTTPS or strict loopback HTTP (`127.0.0.1`, `localhost`, `[::1]`) without embedded URL credentials, and keep `redirect: "error"` on authenticated or loopback requests.

## 4. Provenance Honesty and Graceful Degradation

- **Never claim unverified hardware equivalence**: Passing unit tests or desktop mobile-emulation checks never substitutes for physical device or acoustic sign-off in `docs/qa/acceptance-checklist.md`. Label unverified environments honestly as `Pending` or `Emulated`.
- **Bound failure latency on optional local services**: Optional local integrations (`Voice Daemon`, post-dictation LLM polish, hands-free `Barge-In`) must probe or fail fast (`< 1s` for daemon health/offline fallback) and degrade cleanly to local WASM, BYOK, or manual/original-text paths without hanging user input.

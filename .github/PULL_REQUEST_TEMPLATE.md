## Summary

<!-- Explain what this PR changes, why it is needed, and the user-visible outcome. -->

## Affected Packages / Areas

- [ ] `packages/voice-core` (`@voice-mode/core`)
- [ ] `packages/voice-browser` (`@voice-mode/browser`)
- [ ] `packages/obsidian-plugin` (`@voice-mode/obsidian-plugin`)
- [ ] Docs / CI / Governance

## Verification Evidence

Run `pnpm run check:all` locally and note the exact environment tested:

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint` (including `eslint-plugin-obsidianmd`)
- [ ] `pnpm run test`
- [ ] `pnpm run build`
- [ ] `pnpm run check:release`
- [ ] Real Obsidian desktop / mobile verification (describe OS, Obsidian version, audio device, or note "N/A — pure logic / docs only")

## Policy & Security Checklist

- [ ] No plaintext secrets stored in `data.json` or logged to console (uses Obsidian `SecretStorage`)
- [ ] No model binaries, recordings, credentials, or `main.js` committed to git
- [ ] No unverified feature claims added to `README.md`, `README.en.md`, or `docs/rules/STATE.md`
- [ ] Any external URLs, model sources, or permissions are disclosed in `README.md` and `SECURITY.md`

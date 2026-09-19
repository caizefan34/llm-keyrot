# Proposed Release Notes — v0.3.0 (Not Published)

> Status: **Proposed draft**. This file is for review and is not a published GitHub Release.

## Highlights

- Added first-class TypeScript declarations across the public API (`KeyRotator`, options/config shapes, failure/action objects, and adapters).
- Exposed package types metadata and typed subpath exports for adapters.
- Added deterministic integration demos for Anthropic and Gemini (no real credentials required).
- Improved README hero/onboarding with request-flow visualization and clearer llm-keyrot vs gateway positioning.
- Refined release messaging around rate-limit resilience (`Retry-After`, cooldown, rotation, failover) with no bypass language.

## Full Notes

### Added

- `lib/index.d.ts`
- `adapters/http-interceptor.d.ts`
- `adapters/openai-node.d.ts`
- `adapters/dsh.d.ts`
- `examples/anthropic-integration-demo.js`
- `examples/gemini-integration-demo.js`

### Changed

- `package.json` now advertises types and typed adapter exports.
- `README.md` updated top-section messaging and comparison guidance.
- `CHANGELOG.md` includes v0.3.0 entry.
- `test/index.test.js` includes checks for type-export metadata and deterministic new examples.

### Verification Summary (pre-release)

- Existing test suite passes.
- Deterministic examples run without real keys.
- npm package dry-run includes declarations and examples.
- README links validated.
- Minimal TypeScript consumer project resolves declarations.
- Secret scan run on changed files.

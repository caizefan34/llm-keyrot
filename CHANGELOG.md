# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-09-19

### Added

- TypeScript declarations for public APIs and adapters (`lib/index.d.ts`, `adapters/*.d.ts`).
- Deterministic integration demos for Anthropic and Gemini using placeholders/environment variables (no real keys required).
- Proposed release notes artifact: `RELEASE_NOTES_v0.3.0.md`.

### Changed

- Package exports now include TypeScript declaration metadata for root and adapter subpath imports.
- README top section now highlights rate-limit resilience messaging, request flow, and llm-keyrot vs gateway guidance.
- Documentation wording now emphasizes authorized API key pools, honoring `Retry-After`, cooldown, and failover.

### Added

- Deterministic no-key demos for key rotation and cross-provider fallback.
- Quickstart and discovery metadata documentation.
- Issue templates, pull request template, and security policy.
- Adapter tests for retry limits, retry-after parsing, and non-429 error behavior.

### Changed

- README rewritten for clearer value proposition and safer integration guidance.
- Improved adapter retry behavior and Retry-After parsing.
- `KeyRotator` now validates required constructor options.
- `dispose()` now cancels pending cooldown waits.

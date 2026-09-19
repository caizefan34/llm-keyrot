# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

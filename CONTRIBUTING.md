# Contributing

This is a personal fork of [NanoClaw](https://github.com/qwibitai/nanoclaw), customized as a university teaching assistant. Upstream contributions should go to the upstream repo directly.

## PRs in this repo

All PRs target `SimonKvalheim/universityClaw` — never the upstream `qwibitai/nanoclaw` repo.

```bash
# Correct
gh pr create --repo SimonKvalheim/universityClaw --base main

# The gh default is already set, so this also works
gh pr create --base main
```

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run all tests (vitest)
```

## Testing

Run `npm test` before opening a PR. For ingestion pipeline changes, also do a manual end-to-end test (drop a PDF into `upload/`).

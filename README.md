# AI Company Watch

`AI Company Watch` is a small V1 digest for major official updates from top AI companies.

What it does:
- checks a curated list of official company pages
- discovers RSS/Atom feeds when available, with HTML fallbacks
- deduplicates against local state so you only see new items
- scores items into `critical`, `important`, and `digest`
- writes a markdown digest plus a machine-readable JSON file
- supports both local runs and a scheduled/manual GitHub Actions workflow

## Initial Watchlist

- OpenAI
- Anthropic News
- Anthropic Engineering
- Google AI
- Google DeepMind
- Meta Newsroom
- Microsoft AI

## Project Layout

- `config/sources.json`: source configuration and AI filters
- `scripts/run-digest.js`: fetch, normalize, score, and render the digest
- `state/state.json`: local dedupe state
- `output/latest-digest.md`: latest markdown digest
- `output/latest-items.json`: latest structured output
- `.github/workflows/digest.yml`: scheduled and manual GitHub Actions run

## Local Usage

Run the digest locally:

```bash
node scripts/run-digest.js
```

Useful options:

```bash
node scripts/run-digest.js --lookback-days 7
node scripts/run-digest.js --total-limit 20
node scripts/run-digest.js --source openai-newsroom --source anthropic-news
node scripts/run-digest.js --no-write
```

Outputs:
- prints the markdown digest to stdout
- writes `output/latest-digest.md`
- writes `output/latest-items.json`
- updates `state/state.json`

## GitHub Actions

The workflow runs daily at `14:05 UTC` and also supports manual runs from the GitHub Actions UI.

The workflow:
- runs `node scripts/run-digest.js`
- publishes the markdown digest into the workflow summary
- commits the latest digest, JSON output, and dedupe state back to the repo

## Notes

- V1 is intentionally narrow: official company sources first, no Slack/email delivery yet.
- If a source exposes RSS/Atom, the script uses that first because dates and summaries are more reliable.
- Broad tech news sources and social sources can be added later as separate adapters.

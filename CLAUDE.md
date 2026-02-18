# wopr-plugin-github

GitHub integration for WOPR — webhooks, PR management, repo interactions via chat.

## Commands

```bash
npm run build     # tsc
npm run check     # biome check + tsc --noEmit (run before committing)
npm run format    # biome format --write src/
npm test          # vitest run
```

## Architecture

```
src/
  index.ts  # Plugin entry — GitHub App/webhook setup
  types.ts  # Plugin-local types
```

## Key Details

- Receives GitHub webhooks (PRs, issues, comments, pushes)
- Enables chat commands to interact with GitHub repos (open PR, check CI, etc.)
- Auth: GitHub App (recommended) or Personal Access Token via plugin config
- **Requires a public URL** for GitHub webhook delivery — use `wopr-plugin-tailscale-funnel` for local dev
- Webhook secret validated on every incoming payload — never skip this

## Plugin Contract

Imports only from `@wopr-network/plugin-types`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). No GitHub issues — use Linear. Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-github`.

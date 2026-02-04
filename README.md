# wopr-plugin-github

GitHub integration for WOPR - webhooks, PR notifications, and repository management.

## Prerequisites

- [GitHub CLI (gh)](https://cli.github.com/) installed and authenticated (`gh auth login`)
- [wopr-plugin-tailscale-funnel](https://github.com/wopr-network/wopr-plugin-tailscale-funnel) for public webhook URLs
- WOPR webhooks extension configured

## Installation

```bash
wopr plugin add wopr-network/wopr-plugin-github
```

## Configuration

In your WOPR config (`~/.wopr/config.json`):

```json
{
  "plugins": {
    "wopr-plugin-github": {
      "orgs": ["wopr-network"],
      "prReviewSession": "discord:misfits:#pay-no-attention-to-the-man-behind-the-curtain",
      "releaseSession": "discord:misfits:#releases"
    }
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `orgs` | array | `[]` | GitHub organizations to manage webhooks for |
| `prReviewSession` | string | - | WOPR session to route PR events to |
| `releaseSession` | string | - | WOPR session to route merge/release events to |

## CLI Commands

```bash
# Check GitHub integration status
wopr github status

# Set up webhooks for all configured orgs
wopr github setup

# Set up webhook for a specific org
wopr github setup my-org

# Show webhook URL
wopr github url
```

## Extension API

Other plugins can use the GitHub extension:

```typescript
const github = ctx.getExtension("github") as GitHubExtension;

// Check if gh CLI is authenticated
const authed = await github.isAuthenticated();

// Get the webhook URL
const url = await github.getWebhookUrl();

// Set up webhook for an org
const result = await github.setupWebhook("my-org");
if (result.success) {
  console.log(`Webhook ID: ${result.webhookId}`);
  console.log(`URL: ${result.webhookUrl}`);
} else {
  console.error(result.error);
}
```

## How It Works

1. Plugin uses `gh` CLI to interact with GitHub API
2. When setting up webhooks, it uses the `funnel` extension to get a public URL
3. Creates org-level webhooks that send PR and review events to WOPR
4. Events are routed to configured WOPR sessions for processing

## Dependencies

This plugin works in conjunction with:
- **wopr-plugin-tailscale-funnel** - Provides public URLs via Tailscale Funnel
- **WOPR webhooks extension** - Routes incoming webhooks to sessions

## Supported Events

Currently configured events:
- `pull_request` - PR opened, closed, merged, etc.
- `pull_request_review` - Reviews submitted

## License

MIT
# Test
# Testing webhook

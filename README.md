# GitHub App `workflow_run.completed` Webhook Handler (Cloudflare Workers)

This Worker:
- verifies GitHub webhook signatures (`X-Hub-Signature-256`)
- handles only `workflow_run` events with `action=completed`
- extracts repository, branch/PR, and workflow run ID
- fetches workflow run artifacts
- downloads artifact zip files and extracts `.patch` files
- passes each patch to a patch-processing module

## Setup

1. Install deps:

```bash
npm install
```

2. Set Worker secrets:

```bash
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

`GITHUB_APP_PRIVATE_KEY` should be your GitHub App PEM key contents.

3. Run locally:

```bash
npm run dev
```

4. Deploy:

```bash
npm run deploy
```

## GitHub App configuration

In your GitHub App settings:

- **Webhook URL**: your Worker URL
- **Webhook secret**: same value as `GITHUB_WEBHOOK_SECRET`
- **Subscribe to events**: `Workflow run`
- **Permissions**:
  - `Actions: Read` (required to list/download artifacts)

## Patch processing

Patch handoff happens in:

- `src/patch-processor.ts`

Replace `processPatch(...)` with your real patch pipeline logic.

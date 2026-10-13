# Getting started

## Prerequisites

- Node.js ≥ 22.13 (needs the built-in `node:sqlite`; developed and tested on Node 25.9) and npm ≥ 10.
- No database server, Docker or C compiler is required.

## Install and build

```bash
npm install
npm run build        # tsc -b engine + server, then vite build for the web app
```

## Run in production mode (API + built UI on one port)

```bash
npm run cli -- seed                # creates admin/editor/operator/viewer@example.com (password Passw0rd!demo)
export NODE_ENV=production
export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export WEB_DIST=apps/web/dist
npm start                          # http://127.0.0.1:4000
```

To use your own accounts instead of the demo ones:
`npm run cli -- create-user --email you@corp.test --name You --role admin --password '…'`.

## Development mode

Use two terminals:

```bash
npm run dev:server   # tsx watch on apps/server (port 4000, ephemeral JWT secret)
npm run dev:web      # Vite dev server on http://localhost:5173, proxies /api to :4000
```

## A five-minute tour

1. Sign in as `editor@example.com`. Open **Purchase order approval** (seeded).
2. In the editor:
   - Drag nodes, and pan the canvas by dragging the background. The mouse wheel zooms.
   - Drag from a node's output port (right side) to another node's input port (left side) to connect them.
   - Click a node to edit its configuration. Errors appear in the panel and as red badges on the canvas.
   - Press **Delete** to remove the selection, and Ctrl+Z / Ctrl+Y to undo and redo.
3. Click **Publish**. Open **Share** to see the webhook URL and secret.
4. Trigger it with a signed webhook:
   ```bash
   node examples/send-webhook.mjs <workflowId> <secret> '{"orderId":"PO-1","amount":4200}'
   ```
5. Sign in as `operator@example.com` (or admin), go to **Approvals** and approve. The run completes. **Runs** shows the
   timeline, and **Dashboard** shows the success rate and durations.

`examples/smoke.sh` automates the whole flow with curl, including waiting for a scheduled workflow to fire:

```bash
BASE=http://127.0.0.1:4000 bash examples/smoke.sh
```

## Configuration

Set configuration through environment variables (see `.env.example`), or through a JSON file pointed to by `EWB_CONFIG`
that uses camelCase keys, for example `{ "port": 4100, "httpAllowList": ["api.internal"] }`. Environment variables win.
Invalid values stop the process at startup with a descriptive message (exit code 2).

## Running the tests

```bash
npm test                      # all projects
npx vitest run --project engine
npx vitest run --project integration
npm run typecheck && npm run lint
```

## Useful CLI commands

```bash
npm run cli -- migrate
npm run cli -- validate examples/definitions/order-approval.json
npm run cli -- cron "*/15 9-17 * * MON-FRI" --count 5
```

# PrairieLearn Preview Selector

Optional Next.js app for browsing questions exposed by PrairieLearn's Local Preview Server.
The canonical preview workflow is still the PrairieLearn server's direct URL shape:
`/questions/<qid>?variant=<seed>`.

This app does not start PrairieLearn, proxy preview pages, proxy assets, or render questions. It
fetches `/api/questions` from a running PrairieLearn preview server, shows a searchable list, and
embeds the selected direct preview URL in a sandboxed iframe.

## Setup

```sh
npm install
```

## Run

Start PrairieLearn's Local Preview Server against the bundled sample course:

```sh
npm run render:server
```

Then start this selector app:

```sh
npm run dev
```

Open `http://localhost:3000`.

By default the app reads questions from `http://127.0.0.1:4310`. To use another PrairieLearn
preview server URL:

```sh
PL_PREVIEW_SERVER_URL=http://127.0.0.1:4310 npm run dev
```

Direct PrairieLearn preview URLs also work without this app:

```text
http://127.0.0.1:4310/questions/<qid>?variant=1
```

## Behavior

- Discovery comes from `GET /api/questions` on the configured PrairieLearn preview server.
- Selecting a question points the iframe directly at the PrairieLearn `previewUrl`.
- The iframe sandbox allows only scripts and same-origin behavior.
- The selected `qid` and Stable Preview Variant seed are preserved in this app's URL query string.
- New Variant changes only the selected preview URL's `variant` query parameter.
- Refresh reloads the iframe without changing `qid` or `variant`.
- PrairieLearn render diagnostics stay inside the iframe. This app only reports discovery or
  connection errors.

## Trust model

The standalone PrairieLearn Local Preview Server is unsandboxed in v1. Rendering may execute
question `server.py` under the developer account, and question code has the developer account's
normal outbound network access.

The local server is separate from production Quesal preview. It does not implement Quesal
authorization, Source Course Reference resolution, Temporary Preview Course materialization,
Sandboxed Preview Worker policy, or Preview Shell policy.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

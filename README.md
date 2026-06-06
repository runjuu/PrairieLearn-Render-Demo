# Building a PrairieLearn Preview App

This repository is a developer-facing demo for building a custom preview UI on top of
PrairieLearn's Local Preview Server.

The key idea is that your app owns discovery, navigation, state, and layout, while PrairieLearn
owns question rendering. This demo implements that split with a small Next.js app that discovers
questions from a local course directory and embeds direct PrairieLearn preview URLs in an iframe.

## Run the demo

Requirements:

- Node.js 24 or newer.
- `pnpm`.
- `uv`.

Clone this repo:

```sh
git clone --recurse-submodules git@github.com:runjuu/PrairieLearn-Render-Demo.git
cd PrairieLearn-Render-Demo
```

If you already cloned without submodules, initialize the bundled PrairieLearn checkout:

```sh
git submodule update --init
```

Install dependencies:

```sh
pnpm install
pnpm --dir PrairieLearn install --frozen-lockfile
make -C PrairieLearn python-deps
pnpm --dir PrairieLearn --filter '@prairielearn/prairielearn^...' run build
pnpm --dir PrairieLearn --filter @prairielearn/prairielearn exec compiled-assets build ./assets ./public/build
```

Start the PrairieLearn preview server:

```sh
pnpm run render:server
```

In another terminal, start the Next.js preview app:

```sh
pnpm run dev
```

Open the app:

```text
http://localhost:3000
```

The Next.js app discovers questions from `demo-course/questions/**/info.json`, renders the question
list, and points the iframe directly at the selected preview URL.

## What this demonstrates

- Starting PrairieLearn's standalone Local Preview Server against a local course.
- Discovering questions from `questions/**/info.json`.
- Building stable direct preview URLs with `/questions/<qid>?variant=<seed>`.
- Keeping preview UI state in the app URL without making PrairieLearn responsible for app
  navigation.
- Embedding the rendered question document without proxying PrairieLearn HTML, assets, or generated
  files through the Next.js app.

This is not a production preview service. It is a reference implementation you can copy from when
building your own preview shell, editor preview, review workflow, or course authoring tool.

## Repository map

- `PrairieLearn/apps/prairielearn/src/preview-server.ts` is the Local Preview Server entrypoint.
- `app/` contains the demo Next.js preview app.
- `app/lib/previewDiscovery.ts` shows one simple question discovery strategy.
- `app/lib/previewUrlState.ts` builds direct preview URLs and preserves app selection state.
- `demo-course/` is a minimal PrairieLearn course used by the demo.
- `tests/` covers the demo app's discovery and URL-state helpers.

## Preview server contract

Start the preview server with a PrairieLearn course directory. The course directory must contain a
`questions/` directory.

```sh
pnpm run render:server
```

By default, this serves the bundled `demo-course` at:

```text
http://127.0.0.1:4310
```

Use this direct URL shape to render a question:

```text
GET /questions/<qid>?variant=<seed>
```

For example:

```text
http://127.0.0.1:4310/questions/arithmetic?variant=1
```

`<qid>` is the question path relative to `<course>/questions`. If your `qid` contains nested path
segments, encode each segment and preserve the slashes:

```ts
function previewPathForQid(qid: string) {
  return `/questions/${qid.split('/').map(encodeURIComponent).join('/')}`;
}
```

The preview server returns the rendered HTML document and serves the PrairieLearn assets, course
assets, and generated files that the document references. Your app does not need to call a JSON
rendering API or proxy those files.

The preview server does not provide a question catalog. Your app should discover or receive the list
of previewable questions from a source that fits your product, such as local `info.json` files, an
editor workspace, a search index, or an application database.

## Use your own course

Point both processes at the same PrairieLearn course directory:

```sh
PL_PREVIEW_COURSE_DIR=/path/to/course pnpm run render:server
PL_PREVIEW_COURSE_DIR=/path/to/course pnpm run dev
```

If the preview server runs somewhere other than `http://127.0.0.1:4310`, tell the Next.js app which
base URL to use:

```sh
PL_PREVIEW_SERVER_URL=http://127.0.0.1:4310 pnpm run dev
```

The preview-server wrapper script also reads:

- `PL_PREVIEW_SERVER_HOST`, default `127.0.0.1`.
- `PL_PREVIEW_SERVER_PORT`, default `4310`.

## Building your own preview app

Use this demo as a thin integration reference:

1. Run the PrairieLearn Local Preview Server as a sidecar for the course being previewed.
2. Build or fetch your own question catalog.
3. Convert a selected `qid` and variant seed into `/questions/<qid>?variant=<seed>`.
4. Render that URL in an iframe, a new tab, or a webview controlled by your app.
5. Keep app-specific state, search, selection, and workflow data outside PrairieLearn.

The demo iframe uses:

```tsx
<iframe
  referrerPolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin"
  src={previewUrl}
  title="PrairieLearn question preview"
/>
```

Review the iframe sandbox policy before adding permissions. PrairieLearn questions may execute
scripts and load generated assets as part of normal rendering, but your application still controls
which browser capabilities the embedded preview receives.

## Local trust model

The standalone PrairieLearn Local Preview Server is currently unsandboxed. Rendering may execute
question `server.py` as the developer's local user account, and question code has the same outbound
network access as that account.

Run it on trusted course content and bind it to localhost for local development. Do not expose it as
a shared service without adding the isolation, authorization, and course-materialization policies
your product requires.

## Checks

```sh
pnpm test
pnpm run typecheck
pnpm run build
```

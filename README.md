# PrairieLearn Render Demo

Small read-only review server for rendering PrairieLearn questions through PrairieLearn's
render-only preview CLI.

## Clone

```sh
git clone --recurse-submodules git@github.com:runjuu/PrairieLearn-Render-Demo.git
cd PrairieLearn-Render-Demo
```

If the repository was cloned without submodules:

```sh
git submodule update --init --recursive
```

## Setup

Install the demo server dependencies:

```sh
npm install
```

Build the nested PrairieLearn preview renderer:

```sh
npm run setup:prairielearn
```

This command runs the PrairieLearn dependency install, Python setup, and build needed to create
`PrairieLearn/apps/prairielearn/dist/cli/preview-render.js`.

## Run

```sh
npm run build:css
npm run setup:prairielearn
npm start
```

Open `http://127.0.0.1:4310`.

The first page lists the demo questions. Select a question to render a preview. The preview page has
only Back and New variant controls; it does not edit, save, parse, grade, or submit answers.

## Checks

```sh
npm run build:css
npm run typecheck
npm test
```

Typechecking uses TypeScript 7 beta through `@typescript/native-preview` and the `tsgo` binary.

## Configuration

- `PL_RENDER_DEMO_PORT`: server port, default `4310`.
- `PL_RENDER_DEMO_NODE_BINARY`: Node.js binary used to run PrairieLearn's preview CLI, default `node`.

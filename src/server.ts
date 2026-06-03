import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(here, '..');
const DEFAULT_PORT = 4310;
const MAX_RENDER_OUTPUT_BYTES = 1024 * 1024;
const PREVIEW_ATTEMPT_TTL_MS = 20 * 60 * 1000;
const PREVIEW_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; form-action 'none'; base-uri 'none'";
const SHELL_CSP =
  "default-src 'none'; frame-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'";

export interface QuestionSummary {
  qid: string;
  title: string;
  topic: string | null;
  type: string | null;
}

interface PreviewDiagnostic {
  code?: string;
  fatal?: boolean;
  message?: string;
  name?: string;
  phase?: string;
}

interface PreviewPayload {
  bodyHtml: string;
  headHtml: string;
  variant: {
    seed: string;
  };
}

type PreviewResult =
  | {
      diagnostics: PreviewDiagnostic[];
      ok: true;
      payload: PreviewPayload;
    }
  | {
      diagnostics: PreviewDiagnostic[];
      ok: false;
    };

interface PreviewAttempt {
  createdAt: number;
  diagnostics: PreviewDiagnostic[];
  id: string;
  payload: PreviewPayload;
  qid: string;
  variantSeed: string;
}

interface CreateAppOptions {
  courseDir?: string;
  nodeBinary?: string;
  prairieLearnDir?: string;
  projectRoot?: string;
  renderScript?: string;
  renderTimeoutMs?: number;
  renderer?: (input: {
    attemptId: string;
    qid: string;
    urlPrefix: string;
    variantSeed: string;
  }) => Promise<PreviewResult>;
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.gif':
      return 'image/gif';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ttf':
      return 'font/ttf';
    case '.wasm':
      return 'application/wasm';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function boundedTextCollector(maxBytes: number) {
  let size = 0;
  let truncated = false;
  const chunks: Buffer[] = [];

  return {
    collect(chunk: Buffer) {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - size;
      const next = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(next);
      size += next.byteLength;
      if (chunk.byteLength > remaining) truncated = true;
    },
    value() {
      return {
        text: Buffer.concat(chunks).toString('utf8'),
        truncated,
      };
    },
  };
}

function validateRelativePath(value: string, label = 'path'): string {
  if (!value) throw new Error(`${label} must be non-empty`);
  if (value.includes('\\') || value.includes('\0')) throw new Error(`${label} is invalid`);
  if (path.posix.isAbsolute(value) || path.isAbsolute(value)) {
    throw new Error(`${label} must be relative`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain empty, dot, or dot-dot segments`);
  }
  return value;
}

function ensureInside(basePath: string, candidatePath: string): string {
  const base = path.resolve(basePath);
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(base, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error('path escapes allowed root');
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const marker = text.match(/\n\{\s*"ok"\s*:/);
    if (marker?.index == null) throw firstError;
    return JSON.parse(text.slice(marker.index + 1));
  }
}

function isPreviewResult(value: unknown): value is PreviewResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.ok === 'boolean' && Array.isArray(record.diagnostics);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
}

export async function listQuestions(courseDir: string): Promise<QuestionSummary[]> {
  const questionsRoot = path.join(courseDir, 'questions');
  const questions: QuestionSummary[] = [];

  async function walk(dir: string, parts: string[] = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, [...parts, entry.name]);
        continue;
      }
      if (entry.isFile() && entry.name === 'info.json') {
        const qid = parts.join('/');
        try {
          const info = await readJsonFile(absolute);
          questions.push({
            qid,
            title: typeof info.title === 'string' ? info.title : qid,
            topic: typeof info.topic === 'string' ? info.topic : null,
            type: typeof info.type === 'string' ? info.type : null,
          });
        } catch {
          questions.push({ qid, title: qid, topic: null, type: 'invalid-info-json' });
        }
      }
    }
  }

  await walk(questionsRoot);
  return questions.sort((a, b) => a.qid.localeCompare(b.qid));
}

async function serveFile(filePath: string, headers: Record<string, string> = {}) {
  const bytes = await fs.readFile(filePath);
  return new Response(bytes, {
    headers: {
      'cache-control': 'no-store',
      'content-type': contentTypeFor(filePath),
      ...headers,
    },
  });
}

async function serveBoundedFile(root: string, relativePath: string) {
  try {
    const safePath = validateRelativePath(relativePath);
    const target = ensureInside(root, path.join(root, safePath));
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return new Response('Not found', { status: 404 });
    return serveFile(target, { 'cache-control': 'private, max-age=300' });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function shellHtml(attemptId: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${SHELL_CSP}">
    <style>
      html, body { height: 100%; margin: 0; background: #fff; }
      iframe { border: 0; display: block; height: 100%; min-height: 100vh; width: 100%; }
    </style>
  </head>
  <body>
    <iframe
      referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin"
      src="/attempts/${attemptId}/frame"
      title="PrairieLearn question preview"
    ></iframe>
  </body>
</html>`;
}

function frameHtml(attempt: PreviewAttempt): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
    ${attempt.payload.headHtml}
    <style>
      body { margin: 0; padding: 20px; background: #fff; color: #202124; font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .preview-question { max-width: 960px; margin: 0 auto; }
      img, svg, canvas, video { max-width: 100%; }
    </style>
  </head>
  <body>
    <main class="preview-question">${attempt.payload.bodyHtml}</main>
    <script>
      document.addEventListener('submit', (event) => event.preventDefault(), true);
    </script>
  </body>
</html>`;
}

export async function renderWithPrairieLearnCli({
  courseDir,
  nodeBinary,
  prairieLearnDir,
  qid,
  renderScript,
  renderTimeoutMs,
  urlPrefix,
  variantSeed,
}: {
  courseDir: string;
  nodeBinary: string;
  prairieLearnDir: string;
  qid: string;
  renderScript: string;
  renderTimeoutMs: number;
  urlPrefix: string;
  variantSeed: string;
}): Promise<PreviewResult> {
  try {
    await fs.access(renderScript);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        [
          `PrairieLearn preview renderer is missing: ${renderScript}`,
          'Run `npm run setup:prairielearn` from the demo repo, then restart `npm start`.',
          'If the PrairieLearn submodule is missing, first run `git submodule update --init --recursive`.',
        ].join('\n'),
      );
    }
    throw error;
  }

  const stdout = boundedTextCollector(MAX_RENDER_OUTPUT_BYTES);
  const stderr = boundedTextCollector(MAX_RENDER_OUTPUT_BYTES);
  const child = spawn(
    nodeBinary,
    [
      renderScript,
      '--course-dir',
      courseDir,
      '--qid',
      qid,
      '--variant-seed',
      variantSeed,
      '--url-prefix',
      urlPrefix,
      '--workers-execution-mode',
      'native',
      '--question-timeout-ms',
      '5000',
    ],
    {
      cwd: prairieLearnDir,
      env: {
        ...process.env,
        PL_DISABLE_LOAD_REPORTING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout.on('data', (chunk: Buffer) => stdout.collect(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.collect(chunk));

  let timedOut = false;
  const closeInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, renderTimeoutMs);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );

  if (timedOut) {
    return {
      diagnostics: [
        {
          fatal: true,
          message: `Preview timed out after ${renderTimeoutMs}ms`,
          name: 'PreviewTimeout',
        },
      ],
      ok: false,
    };
  }

  if (closeInfo.code !== 0) {
    return {
      diagnostics: [
        {
          fatal: true,
          message: `PrairieLearn preview-render exited with code ${closeInfo.code} and signal ${closeInfo.signal ?? 'none'}.\n${stderr.value().text}`,
          name: 'PreviewProcessFailed',
        },
      ],
      ok: false,
    };
  }

  const parsed = parseJsonPayload(stdout.value().text);
  if (!isPreviewResult(parsed)) {
    return {
      diagnostics: [
        {
          fatal: true,
          message: 'PrairieLearn preview-render did not return a preview envelope.',
          name: 'PreviewOutputInvalid',
        },
      ],
      ok: false,
    };
  }

  return parsed;
}

export function createApp(options: CreateAppOptions = {}) {
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const publicRoot = path.join(projectRoot, 'public');
  const courseDir = path.resolve(options.courseDir ?? path.join(projectRoot, 'demo-course'));
  const prairieLearnDir = path.resolve(
    options.prairieLearnDir ?? path.join(projectRoot, 'PrairieLearn'),
  );
  const renderScript =
    options.renderScript ??
    path.join(prairieLearnDir, 'apps', 'prairielearn', 'dist', 'cli', 'preview-render.js');
  const nodeBinary = options.nodeBinary ?? process.env.PL_RENDER_DEMO_NODE_BINARY ?? 'node';
  const renderTimeoutMs = options.renderTimeoutMs ?? 20_000;
  const attempts = new Map<string, PreviewAttempt>();
  const app = new Hono();

  function getAttempt(attemptId: string) {
    const attempt = attempts.get(attemptId);
    if (!attempt || Date.now() - attempt.createdAt > PREVIEW_ATTEMPT_TTL_MS) {
      attempts.delete(attemptId);
      return null;
    }
    return attempt;
  }

  async function renderPreview(input: {
    attemptId: string;
    qid: string;
    urlPrefix: string;
    variantSeed: string;
  }) {
    if (options.renderer) return options.renderer(input);
    return renderWithPrairieLearnCli({
      courseDir,
      nodeBinary,
      prairieLearnDir,
      qid: input.qid,
      renderScript,
      renderTimeoutMs,
      urlPrefix: input.urlPrefix,
      variantSeed: input.variantSeed,
    });
  }

  app.get('/', async () => serveFile(path.join(publicRoot, 'index.html')));
  app.get('/app.js', async () => serveFile(path.join(publicRoot, 'app.js')));
  app.get('/styles.css', async () => serveFile(path.join(publicRoot, 'styles.css')));
  app.get('/favicon.ico', () => new Response(null, { status: 204 }));
  app.get('/health', (c) =>
    c.json({
      ok: true,
      renderScript,
    }),
  );

  app.get('/api/questions', async (c) => c.json({ questions: await listQuestions(courseDir) }));

  app.post('/api/preview', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      qid?: unknown;
      variantSeed?: unknown;
    };
    if (typeof body.qid !== 'string') {
      return c.json({ error: 'qid is required', ok: false }, 400);
    }

    let qid: string;
    try {
      qid = validateRelativePath(body.qid, 'qid');
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error), ok: false }, 400);
    }

    const variantSeed = typeof body.variantSeed === 'string' ? body.variantSeed : '1';
    const attemptId = crypto.randomUUID();
    let result: PreviewResult;
    try {
      result = await renderPreview({
        attemptId,
        qid,
        urlPrefix: `/preview-assets/${attemptId}`,
        variantSeed,
      });
    } catch (error) {
      result = {
        diagnostics: [
          {
            fatal: true,
            message: error instanceof Error ? error.message : String(error),
            name: 'PreviewSetupError',
          },
        ],
        ok: false,
      };
    }

    if (!result.ok) {
      return c.json(result, 422);
    }

    attempts.set(attemptId, {
      createdAt: Date.now(),
      diagnostics: result.diagnostics,
      id: attemptId,
      payload: result.payload,
      qid,
      variantSeed: result.payload.variant.seed,
    });

    return c.json({
      attemptId,
      diagnostics: result.diagnostics,
      ok: true,
      previewUrl: `/attempts/${attemptId}/shell`,
      variant: result.payload.variant,
    });
  });

  app.get('/attempts/:attemptId/shell', (c) => {
    const attempt = getAttempt(c.req.param('attemptId'));
    if (!attempt) return new Response('Not found', { status: 404 });
    return new Response(shellHtml(attempt.id), {
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': SHELL_CSP,
        'content-type': 'text/html; charset=utf-8',
      },
    });
  });

  app.get('/attempts/:attemptId/frame', (c) => {
    const attempt = getAttempt(c.req.param('attemptId'));
    if (!attempt) return new Response('Not found', { status: 404 });
    return new Response(frameHtml(attempt), {
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': PREVIEW_CSP,
        'content-type': 'text/html; charset=utf-8',
      },
    });
  });

  app.get('/preview-assets/:attemptId/*', async (c) => {
    const attemptId = c.req.param('attemptId');
    const attempt = getAttempt(attemptId);
    if (!attempt) return new Response('Not found', { status: 404 });

    const prefix = `/preview-assets/${attemptId}/`;
    const assetPath = decodeURIComponent(c.req.path.slice(prefix.length));
    const parts = assetPath.split('/').filter(Boolean);
    const kind = parts[0];
    const relative = parts.slice(1).join('/');

    if (kind === 'generatedFilesQuestion') {
      return new Response('Generated preview files are not supported in this demo.', {
        status: 404,
      });
    }

    const roots: Record<string, string> = {
      clientFilesCourse: path.join(courseDir, 'clientFilesCourse'),
      clientFilesQuestion: path.join(courseDir, 'questions', attempt.qid, 'clientFilesQuestion'),
      elementExtensions: path.join(courseDir, 'elementExtensions'),
      elements: path.join(courseDir, 'elements'),
    };
    const root = kind ? roots[kind] : undefined;
    if (!root || !relative) return new Response('Not found', { status: 404 });
    return serveBoundedFile(root, relative);
  });

  app.get('/assets/*', async (c) => {
    const assetPath = decodeURIComponent(c.req.path.slice('/assets/'.length));
    const parts = assetPath.split('/').filter(Boolean);
    let root: string | null = null;
    let relative = '';

    if (parts[0] === 'node_modules') {
      root = path.join(prairieLearnDir, 'node_modules');
      relative = parts.slice(2).join('/');
    } else if (parts[0] === 'build') {
      root = path.join(prairieLearnDir, 'apps', 'prairielearn', 'public', 'build');
      relative = parts.slice(1).join('/');
    } else if (parts[0] === 'public') {
      root = path.join(prairieLearnDir, 'apps', 'prairielearn', 'public');
      relative = parts.slice(2).join('/');
    } else if (parts[0] === 'elements') {
      root = path.join(prairieLearnDir, 'apps', 'prairielearn', 'elements');
      relative = parts.slice(2).join('/');
    }

    if (!root || !relative) return new Response('Not found', { status: 404 });
    return serveBoundedFile(root, relative);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PL_RENDER_DEMO_PORT ?? DEFAULT_PORT);
  const app = createApp();
  serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port,
    },
    (info) => {
      console.log(`PrairieLearn Render Demo listening on http://127.0.0.1:${info.port}`);
    },
  );
}

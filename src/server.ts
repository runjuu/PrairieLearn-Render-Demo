import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(here, '..');
const DEFAULT_PORT = 4310;
const MAX_RENDER_OUTPUT_BYTES = 1024 * 1024;
const PREVIEW_ATTEMPT_TTL_MS = 20 * 60 * 1000;
const PREVIEW_ASSETS_PREFIX = '/preview-assets';
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

type WarmServeEnvelope =
  | {
      ok: true;
      type: 'ready';
    }
  | {
      diagnostics: PreviewDiagnostic[];
      durationMs: number;
      id?: unknown;
      ok: true;
      payload: PreviewPayload;
      type: 'response';
    }
  | {
      diagnostics: PreviewDiagnostic[];
      durationMs: number;
      id?: unknown;
      ok: false;
      type: 'response';
    };

export interface WarmPreviewRendererOptions {
  courseDir: string;
  defaultQid: string;
  nodeBinary: string;
  prairieLearnDir: string;
  renderScript: string;
  renderTimeoutMs: number;
  startupTimeoutMs?: number;
  urlPrefix: string;
}

interface PreviewAttempt {
  createdAt: number;
  diagnostics: PreviewDiagnostic[];
  id: string;
  payload: PreviewPayload;
  qid: string;
  variantSeed: string;
}

interface RendererProcessExit {
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
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

function isPreviewPayload(value: unknown): value is PreviewPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const variant = record.variant;
  return (
    typeof record.bodyHtml === 'string' &&
    typeof record.headHtml === 'string' &&
    typeof variant === 'object' &&
    variant !== null &&
    !Array.isArray(variant) &&
    typeof (variant as Record<string, unknown>).seed === 'string'
  );
}

function isWarmServeEnvelope(value: unknown): value is WarmServeEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'ready') return record.ok === true;
  if (record.type !== 'response' || typeof record.ok !== 'boolean') return false;
  if (!Array.isArray(record.diagnostics) || typeof record.durationMs !== 'number') return false;
  return record.ok === false || isPreviewPayload(record.payload);
}

function renderScriptMissingError(renderScript: string) {
  return new Error(
    [
      `PrairieLearn preview renderer is missing: ${renderScript}`,
      'Run `npm run setup:prairielearn` from the demo repo, then restart `npm start`.',
      'If the PrairieLearn submodule is missing, first run `git submodule update --init --recursive`.',
    ].join('\n'),
  );
}

async function assertRenderScriptAvailable(renderScript: string) {
  try {
    await fs.access(renderScript);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw renderScriptMissingError(renderScript);
    }
    throw error;
  }
}

function withTimeout<T>({
  message,
  ms,
  onTimeout,
  promise,
}: {
  message: string;
  ms: number;
  onTimeout?: () => void;
  promise: Promise<T>;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
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

export class WarmPrairieLearnRenderer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exitInfo: RendererProcessExit | null = null;
  private exitPromise: Promise<RendererProcessExit> | null = null;
  private lines: AsyncIterableIterator<string> | null = null;
  private readline: Interface | null = null;
  private renderQueue: Promise<unknown> = Promise.resolve();
  private requestSequence = 0;
  private startPromise: Promise<void> | null = null;
  private stderr = boundedTextCollector(MAX_RENDER_OUTPUT_BYTES);

  constructor(private readonly options: WarmPreviewRendererOptions) {}

  get urlPrefix() {
    return this.options.urlPrefix;
  }

  async start() {
    if (!this.startPromise) {
      this.startPromise = this.startNow().catch(async (error: unknown) => {
        this.startPromise = null;
        await this.close();
        throw error;
      });
    }

    await this.startPromise;
  }

  async render(input: { qid: string; variantSeed: string }): Promise<PreviewResult> {
    await this.start();

    const nextRender = this.renderQueue.then(() => this.renderNow(input));
    this.renderQueue = nextRender.catch(() => undefined);
    return nextRender;
  }

  async close() {
    const child = this.child;
    if (!child) return;

    this.child = null;
    this.startPromise = null;

    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    }

    const exitPromise = this.exitPromise;
    if (exitPromise) {
      try {
        await withTimeout({
          message: 'Timed out while closing the warm PrairieLearn preview renderer.',
          ms: 3000,
          onTimeout: () => child.kill('SIGKILL'),
          promise: exitPromise,
        });
      } catch {
        // Shutdown is best-effort. Render/start paths surface process failures to callers.
      }
    }

    this.readline?.close();
    this.readline = null;
    this.lines = null;
    this.exitPromise = null;
    this.exitInfo = null;
  }

  private async startNow() {
    await assertRenderScriptAvailable(this.options.renderScript);

    this.stderr = boundedTextCollector(MAX_RENDER_OUTPUT_BYTES);
    const child = spawn(
      this.options.nodeBinary,
      [
        this.options.renderScript,
        '--serve',
        '--course-dir',
        this.options.courseDir,
        '--qid',
        this.options.defaultQid,
        '--variant-seed',
        '1',
        '--url-prefix',
        this.options.urlPrefix,
        '--workers-execution-mode',
        'native',
        '--question-timeout-ms',
        '5000',
        '--prewarm-workers',
      ],
      {
        cwd: this.options.prairieLearnDir,
        env: {
          ...process.env,
          PL_DISABLE_LOAD_REPORTING: '1',
        },
        stdio: 'pipe',
      },
    );

    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => this.stderr.collect(chunk));
    this.exitPromise = new Promise<RendererProcessExit>((resolve) => {
      let settled = false;
      const resolveOnce = (info: RendererProcessExit) => {
        if (settled) return;
        settled = true;
        this.exitInfo = info;
        resolve(info);
      };

      child.once('error', (error) => resolveOnce({ code: null, error, signal: null }));
      child.once('close', (code, signal) => resolveOnce({ code, signal }));
    });
    this.readline = createInterface({
      crlfDelay: Infinity,
      input: child.stdout,
      terminal: false,
    });
    this.lines = this.readline[Symbol.asyncIterator]();

    const ready = await this.readEnvelopeWithTimeout({
      message: `Warm PrairieLearn preview renderer did not become ready within ${this.startupTimeoutMs()}ms.`,
      ms: this.startupTimeoutMs(),
      onTimeout: () => child.kill('SIGKILL'),
    });

    if (ready.type !== 'ready' || !ready.ok) {
      throw new Error('Warm PrairieLearn preview renderer returned an invalid ready envelope.');
    }
  }

  private async renderNow(input: { qid: string; variantSeed: string }): Promise<PreviewResult> {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) {
      throw this.processNotRunningError();
    }

    const id = `render-${++this.requestSequence}`;
    const line = `${JSON.stringify({
      id,
      qid: input.qid,
      variantSeed: input.variantSeed,
    })}\n`;

    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const response = await withTimeout({
      message: `Preview timed out after ${this.options.renderTimeoutMs}ms`,
      ms: this.options.renderTimeoutMs,
      onTimeout: () => child.kill('SIGKILL'),
      promise: this.readResponse(id),
    });

    if (response.ok) {
      return {
        diagnostics: response.diagnostics,
        ok: true,
        payload: response.payload,
      };
    }

    return {
      diagnostics: response.diagnostics,
      ok: false,
    };
  }

  private async readResponse(id: string) {
    while (true) {
      const envelope = await this.readEnvelope();
      if (envelope.type === 'ready') continue;
      if (envelope.id !== id) {
        throw new Error(
          `Warm PrairieLearn preview renderer returned response id ${String(envelope.id)} while waiting for ${id}.`,
        );
      }
      return envelope;
    }
  }

  private async readEnvelopeWithTimeout({
    message,
    ms,
    onTimeout,
  }: {
    message: string;
    ms: number;
    onTimeout?: () => void;
  }) {
    return withTimeout({
      message,
      ms,
      onTimeout,
      promise: this.readEnvelope(),
    });
  }

  private async readEnvelope(): Promise<WarmServeEnvelope> {
    while (true) {
      const line = (await this.readLine()).trim();
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (line.startsWith('{')) {
          throw new Error(
            `Warm PrairieLearn preview renderer emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }

      if (isWarmServeEnvelope(parsed)) return parsed;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        throw new Error('Warm PrairieLearn preview renderer emitted an unexpected JSON envelope.');
      }
    }
  }

  private async readLine() {
    if (!this.lines || !this.exitPromise) throw this.processNotRunningError();

    const result = await Promise.race([
      this.lines.next().then((line) => ({ line, type: 'line' }) as const),
      this.exitPromise.then((exitInfo) => ({ exitInfo, type: 'exit' }) as const),
    ]);

    if (result.type === 'exit') throw this.processExitError(result.exitInfo);
    if (result.line.done) throw this.processNotRunningError();
    return result.line.value;
  }

  private processExitError(info: RendererProcessExit) {
    const stderr = this.stderr.value().text.trim();
    const reason = info.error
      ? `failed to start: ${info.error.message}`
      : `exited with code ${info.code ?? 'null'} and signal ${info.signal ?? 'none'}`;
    return new Error(
      `Warm PrairieLearn preview renderer ${reason}.${stderr ? `\n${stderr}` : ''}`,
    );
  }

  private processNotRunningError() {
    if (this.exitInfo) return this.processExitError(this.exitInfo);
    return new Error('Warm PrairieLearn preview renderer is not running.');
  }

  private startupTimeoutMs() {
    return this.options.startupTimeoutMs ?? 60_000;
  }
}

export async function createWarmPrairieLearnRenderer(options: WarmPreviewRendererOptions) {
  const renderer = new WarmPrairieLearnRenderer(options);
  await renderer.start();
  return renderer;
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
  await assertRenderScriptAvailable(renderScript);

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
  let latestAttemptId: string | null = null;
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
        urlPrefix: PREVIEW_ASSETS_PREFIX,
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
    latestAttemptId = attemptId;

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

  app.get('/preview-assets/*', async (c) => {
    const prefix = `${PREVIEW_ASSETS_PREFIX}/`;
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
      elementExtensions: path.join(courseDir, 'elementExtensions'),
      elements: path.join(courseDir, 'elements'),
    };
    const attempt = latestAttemptId ? getAttempt(latestAttemptId) : null;
    const root =
      kind === 'clientFilesQuestion'
        ? attempt
          ? path.join(courseDir, 'questions', attempt.qid, 'clientFilesQuestion')
          : undefined
        : kind
          ? roots[kind]
          : undefined;
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

export async function startServer() {
  const port = Number(process.env.PL_RENDER_DEMO_PORT ?? DEFAULT_PORT);
  const projectRoot = defaultProjectRoot;
  const courseDir = path.join(projectRoot, 'demo-course');
  const prairieLearnDir = path.join(projectRoot, 'PrairieLearn');
  const renderScript = path.join(
    prairieLearnDir,
    'apps',
    'prairielearn',
    'dist',
    'cli',
    'preview-render.js',
  );
  const nodeBinary = process.env.PL_RENDER_DEMO_NODE_BINARY ?? 'node';
  const renderTimeoutMs = 20_000;
  const questions = await listQuestions(courseDir);
  const defaultQid = questions[0]?.qid ?? 'arithmetic';

  console.log('Starting warm PrairieLearn preview renderer...');
  const renderer = await createWarmPrairieLearnRenderer({
    courseDir,
    defaultQid,
    nodeBinary,
    prairieLearnDir,
    renderScript,
    renderTimeoutMs,
    urlPrefix: PREVIEW_ASSETS_PREFIX,
  });
  console.log('Warm PrairieLearn preview renderer is ready.');

  const app = createApp({
    courseDir,
    nodeBinary,
    prairieLearnDir,
    projectRoot,
    renderer: (input) =>
      renderer.render({
        qid: input.qid,
        variantSeed: input.variantSeed,
      }),
    renderScript,
    renderTimeoutMs,
  });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port,
    },
    (info) => {
      console.log(`PrairieLearn Render Demo listening on http://127.0.0.1:${info.port}`);
    },
  );

  server.once('error', (error: NodeJS.ErrnoException) => {
    void renderer.close().finally(() => {
      console.error(error.message);
      process.exit(1);
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    server.close(() => {
      void renderer.close().finally(() => {
        process.exit(0);
      });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createApp } from '../src/server.ts';

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pl-render-demo-'));
}

async function writeQuestion(courseDir: string, qid: string, title: string) {
  const questionDir = path.join(courseDir, 'questions', qid);
  await fs.mkdir(questionDir, { recursive: true });
  await fs.writeFile(
    path.join(questionDir, 'info.json'),
    JSON.stringify({
      title,
      topic: 'Rendering',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111111',
    }),
  );
}

async function makeCourse() {
  const root = await makeTempRoot();
  const courseDir = path.join(root, 'course');
  await fs.mkdir(courseDir, { recursive: true });
  await writeQuestion(courseDir, 'beta/question', 'Beta question');
  await writeQuestion(courseDir, 'alpha/question', 'Alpha question');
  return { courseDir, root };
}

describe('review server', () => {
  it('lists questions from the configured course', async () => {
    const { courseDir, root } = await makeCourse();
    const app = createApp({ courseDir, projectRoot: root });

    const response = await app.request('/api/questions');
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      questions: Array<{ qid: string; title: string }>;
    };

    assert.deepEqual(
      body.questions.map((question) => question.qid),
      ['alpha/question', 'beta/question'],
    );
    assert.equal(body.questions[0]?.title, 'Alpha question');
  });

  it('renders a preview without sending file overlays', async () => {
    const { courseDir, root } = await makeCourse();
    const calls: unknown[] = [];
    const app = createApp({
      courseDir,
      projectRoot: root,
      renderer: async (input) => {
        calls.push(input);
        return {
          diagnostics: [],
          ok: true,
          payload: {
            bodyHtml: '<p>Rendered body</p>',
            headHtml: '<style>.demo { color: red; }</style>',
            variant: { seed: input.variantSeed },
          },
        };
      },
    });

    const response = await app.request('/api/preview', {
      body: JSON.stringify({ qid: 'alpha/question', variantSeed: 'abc123' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { previewUrl: string; variant: { seed: string } };

    assert.equal(body.variant.seed, 'abc123');
    assert.match(body.previewUrl, /^\/attempts\/[-0-9a-f]+\/shell$/);
    assert.deepEqual(calls, [
      {
        attemptId: body.previewUrl.split('/')[2],
        qid: 'alpha/question',
        urlPrefix: '/preview-assets',
        variantSeed: 'abc123',
      },
    ]);
  });

  it('serves shell and frame HTML for a successful attempt', async () => {
    const { courseDir, root } = await makeCourse();
    const app = createApp({
      courseDir,
      projectRoot: root,
      renderer: async (input) => ({
        diagnostics: [],
        ok: true,
        payload: {
          bodyHtml: '<p>Rendered body</p>',
          headHtml: '<title>Attempt head</title>',
          variant: { seed: input.variantSeed },
        },
      }),
    });

    const previewResponse = await app.request('/api/preview', {
      body: JSON.stringify({ qid: 'beta/question' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const preview = (await previewResponse.json()) as { attemptId: string; previewUrl: string };

    const shellResponse = await app.request(preview.previewUrl);
    assert.equal(shellResponse.status, 200);
    assert.match(await shellResponse.text(), new RegExp(`/attempts/${preview.attemptId}/frame`));

    const frameResponse = await app.request(`/attempts/${preview.attemptId}/frame`);
    assert.equal(frameResponse.status, 200);
    const frame = await frameResponse.text();
    assert.match(frame, /Attempt head/);
    assert.match(frame, /Rendered body/);
  });

  it('returns an actionable diagnostic when the PrairieLearn renderer is missing', async () => {
    const { courseDir, root } = await makeCourse();
    const app = createApp({
      courseDir,
      projectRoot: root,
      renderScript: path.join(root, 'missing-preview-render.js'),
    });

    const response = await app.request('/api/preview', {
      body: JSON.stringify({ qid: 'alpha/question' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    assert.equal(response.status, 422);
    const body = (await response.json()) as {
      diagnostics: Array<{ message: string; name: string }>;
      ok: boolean;
    };

    assert.equal(body.ok, false);
    assert.equal(body.diagnostics[0]?.name, 'PreviewSetupError');
    assert.match(body.diagnostics[0]?.message ?? '', /npm run setup:prairielearn/);
  });
});

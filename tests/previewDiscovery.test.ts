import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { discoverPreviewQuestions, isPreviewableQid } from '../app/lib/previewDiscovery.ts';

async function writeQuestionInfo(courseDir: string, qid: string, infoJson: unknown) {
  const questionDir = path.join(courseDir, 'questions', ...qid.split('/'));
  await fs.mkdir(questionDir, { recursive: true });
  await fs.writeFile(path.join(questionDir, 'info.json'), JSON.stringify(infoJson));
}

describe('PrairieLearn preview discovery', () => {
  const tempRoots: string[] = [];
  let courseDir: string;

  beforeEach(async () => {
    courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-discovery-test-'));
    tempRoots.push(courseDir);
  });

  after(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { force: true, recursive: true })));
  });

  it('parses question metadata from course info.json files', async () => {
    await writeQuestionInfo(courseDir, 'unit/alpha', {
      title: 'Alpha question',
      topic: 'Rendering',
      type: 'v3',
    });
    await writeQuestionInfo(courseDir, 'beta', {
      title: 'Beta question',
      tags: ['example'],
      type: 'v3',
    });

    const questions = await discoverPreviewQuestions(courseDir);

    assert.deepEqual(questions, [
      {
        previewUrl: '/questions/beta?variant=1',
        qid: 'beta',
        title: 'Beta question',
        topic: null,
        type: 'v3',
      },
      {
        previewUrl: '/questions/unit/alpha?variant=1',
        qid: 'unit/alpha',
        title: 'Alpha question',
        topic: 'Rendering',
        type: 'v3',
      },
    ]);
  });

  it('stops recursing once a directory is identified as a question', async () => {
    await writeQuestionInfo(courseDir, 'outer', {
      title: 'Outer',
      topic: 'Rendering',
      type: 'v3',
    });
    await writeQuestionInfo(courseDir, 'outer/inner', {
      title: 'Inner',
      topic: 'Rendering',
      type: 'v3',
    });

    const questions = await discoverPreviewQuestions(courseDir);

    assert.deepEqual(
      questions.map((question) => question.qid),
      ['outer'],
    );
  });

  it('keeps malformed question directories visible in the list', async () => {
    const questionDir = path.join(courseDir, 'questions', 'broken');
    await fs.mkdir(questionDir, { recursive: true });
    await fs.writeFile(path.join(questionDir, 'info.json'), '{');

    const questions = await discoverPreviewQuestions(courseDir);

    assert.deepEqual(questions, [
      {
        previewUrl: '/questions/broken?variant=1',
        qid: 'broken',
        title: 'broken',
        topic: null,
        type: 'invalid-info-json',
      },
    ]);
  });

  it('uses the preview server qid rules when discovering questions', async () => {
    await writeQuestionInfo(courseDir, 'valid/nested', {
      title: 'Valid',
      topic: 'Rendering',
      type: 'v3',
    });

    const invalidQuestionDir = path.join(courseDir, 'questions', 'bad\\qid');
    await fs.mkdir(invalidQuestionDir, { recursive: true });
    await fs.writeFile(path.join(invalidQuestionDir, 'info.json'), '{}');

    const questions = await discoverPreviewQuestions(courseDir);

    assert.equal(isPreviewableQid('valid/nested'), true);
    assert.equal(isPreviewableQid('bad\\qid'), false);
    assert.deepEqual(
      questions.map((question) => question.qid),
      ['valid/nested'],
    );
  });
});

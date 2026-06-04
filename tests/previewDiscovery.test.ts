import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';

import { discoverPreviewQuestions, previewServerUrlFromEnv } from '../app/lib/previewDiscovery.ts';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('Server did not bind to a TCP port.'));
    });
  });
}

describe('PrairieLearn preview discovery', () => {
  const servers: http.Server[] = [];

  after(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it('fetches questions from the configured PrairieLearn preview server', async () => {
    const requestedPaths: string[] = [];
    const server = http.createServer((request, response) => {
      requestedPaths.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          questions: [
            {
              previewUrl: '/questions/unit/alpha?variant=1',
              qid: 'unit/alpha',
              title: 'Alpha question',
              topic: 'Rendering',
              type: 'v3',
            },
          ],
        }),
      );
    });
    servers.push(server);
    const port = await listen(server);

    const previewServerUrl = previewServerUrlFromEnv({
      PL_PREVIEW_SERVER_URL: `http://127.0.0.1:${port}/`,
    });
    const questions = await discoverPreviewQuestions(previewServerUrl);

    assert.equal(previewServerUrl, `http://127.0.0.1:${port}`);
    assert.deepEqual(requestedPaths, ['/api/questions']);
    assert.deepEqual(questions, [
      {
        previewUrl: '/questions/unit/alpha?variant=1',
        qid: 'unit/alpha',
        title: 'Alpha question',
        topic: 'Rendering',
        type: 'v3',
      },
    ]);
  });
});

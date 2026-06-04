import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appSearchForSelection,
  directPreviewUrlForSelection,
  randomBase36Variant,
} from '../app/lib/previewUrlState.ts';

describe('preview URL state', () => {
  it('builds direct PrairieLearn preview URLs from discovery previewUrl values', () => {
    const url = directPreviewUrlForSelection({
      previewServerUrl: 'http://127.0.0.1:4310',
      previewUrl: '/questions/unit/alpha?variant=1',
      variant: 'abc123',
    });

    assert.equal(url, 'http://127.0.0.1:4310/questions/unit/alpha?variant=abc123');
  });

  it('preserves selected qid and variant in the app search string', () => {
    assert.equal(
      appSearchForSelection({
        existingSearch: '?filter=alpha',
        qid: 'unit/alpha',
        variant: 'abc123',
      }),
      '?filter=alpha&qid=unit%2Falpha&variant=abc123',
    );
  });

  it('generates non-empty base36 variant seeds', () => {
    assert.match(randomBase36Variant(), /^[0-9a-z]+$/);
  });

  it('generates PrairieLearn-compatible 32-bit variant seeds', () => {
    const seed = randomBase36Variant();
    const parsed = Number.parseInt(seed, 36);

    assert.ok(Number.isSafeInteger(parsed));
    assert.ok(parsed >= 1);
    assert.ok(parsed <= 0xffffffff);
  });
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '../vendor/chromium-dino');

test('vendored Chromium files are byte-identical to VENDOR.md', () => {
  const lines = readFileSync(path.join(dir, 'VENDOR.md'), 'utf8').split('\n');
  const entries = lines.map((l) => l.trim().match(/^([0-9a-f]{64})\s+\.\/(.+)$/)).filter((m) => m !== null);
  assert.ok(entries.length >= 20, `expected hashes in VENDOR.md, got ${entries.length}`);
  for (const [, sha, file] of entries) {
    const actual = createHash('sha256').update(readFileSync(path.join(dir, file!))).digest('hex');
    assert.equal(actual, sha, `${file} changed; vendored files must stay unedited`);
  }
});

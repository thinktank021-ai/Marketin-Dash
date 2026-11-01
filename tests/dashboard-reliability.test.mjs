import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalRoute } from '../app/route-normalization.ts';
import { canReadBrandSource } from '../app/brand-source-policy.ts';
import { oncePerDatabase } from '../app/api/brands/storage-initialization.ts';

test('approved Georgia routes normalize with old, empty and custom brand rules', () => {
  for (const rules of [[], [{ target: 'گرجستان', aliases: ['تفلیس', 'باتومی'] }]]) {
    for (const route of ['تفلیس', 'باتومی', 'گرجستان', 'تفلیس باتومی', 'تفلیس-باتومی', 'باتومی / تفلیس', 'تفليس و باتومی', 'تفلیس‌باتومی', 'تفلیس، باتومی']) {
      assert.equal(canonicalRoute(route, rules), 'گرجستان', route);
    }
    assert.equal(canonicalRoute('دبی تفلیس', rules), 'دبی تفلیس');
    assert.equal(canonicalRoute('استانبول', rules), 'استانبول');
    assert.equal(canonicalRoute('', rules), 'مسیر ثبت نشده');
  }
  assert.equal(canonicalRoute('دبى', [{ target: 'امارات', aliases: ['دبی'] }]), 'امارات');
  const counts = ['تفلیس باتومی', 'گرجستان', 'تفلیس', 'دبی'].reduce((map, route) => { const key = canonicalRoute(route); map[key] = (map[key] || 0) + 1; return map; }, {});
  assert.deepEqual(counts, { گرجستان: 3, دبی: 1 });
});

test('temporary source health failures cannot revoke active source access', () => {
  for (const sheetStatus of ['connected', 'error', 'warning', 'pending']) {
    assert.equal(canReadBrandSource({ configStatus: 'active', sheetCsvUrl: 'https://source.test/a', sheetStatus }), true);
    assert.equal(canReadBrandSource({ configStatus: 'draft', sheetCsvUrl: 'https://source.test/a', sheetStatus }), false);
  }
  assert.equal(canReadBrandSource({ configStatus: 'active', sheetCsvUrl: '' }), false);
});

test('storage bootstrap runs once under concurrent traffic, isolates databases and retries failures', async () => {
  const db = {}; let calls = 0;
  const init = async () => { calls++; return db; };
  await Promise.all(Array.from({ length: 50 }, () => oncePerDatabase(db, 'seed', init)));
  assert.equal(calls, 1);
  await oncePerDatabase({}, 'seed', init); assert.equal(calls, 2);
  await assert.rejects(oncePerDatabase(db, 'retry', async () => { throw Error('temporary'); }));
  assert.equal(await oncePerDatabase(db, 'retry', async () => 42), 42);
});

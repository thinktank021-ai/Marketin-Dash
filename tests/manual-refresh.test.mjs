import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ManualRefreshController, RefreshGate } from '../app/manual-refresh.ts';

test('all six view loaders run, after discovery and before derived status, with force active from the first request', async () => {
  const controller = new ManualRefreshController(), order = [];
  controller.register('metadata', async () => { assert.equal(controller.active, true); order.push('metadata'); }, 0);
  for (const view of ['dashboard', 'ads', 'contracts', 'extraction', 'budgets', 'settings']) controller.register(view, async () => { assert.equal(controller.active, true); order.push(view); });
  controller.register('health', async () => order.push('health'), 2);
  assert.deepEqual(await controller.run(), []);
  assert.equal(order[0], 'metadata'); assert.equal(order.at(-1), 'health');
  assert.equal(order.length, 8); assert.equal(controller.active, false);
});

test('double clicks share one refresh and the busy state lasts until real work completes', async () => {
  const controller = new ManualRefreshController(); let finish; let calls = 0;
  controller.register('pending', () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = controller.run(), second = controller.run(); assert.equal(first, second);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.active, true); assert.equal(calls, 1);
  finish(); await first; assert.equal(controller.active, false);
});

test('failed sources do not block other tabs and a later retry can succeed', async () => {
  const controller = new ManualRefreshController(); let count = 0;
  const unregister = controller.register('failed', async () => { throw Error('offline'); });
  controller.register('good', async () => { count++; controller.warn('stale cache'); });
  assert.deepEqual(await controller.run(), ['failed: offline', 'stale cache']);
  unregister(); assert.deepEqual(await controller.run(), ['stale cache']); assert.equal(count, 2);
});

test('a forced refresh during background polling queues a fresh read instead of doing nothing', async () => {
  const gate = new RefreshGate(); let finish; let reads = 0;
  const background = gate.run(() => new Promise(resolve => { reads++; finish = resolve; }));
  const manual = gate.run(async () => { reads++; }, true);
  assert.equal(reads, 1); finish(); await Promise.all([background, manual]); assert.equal(reads, 2);
});

test('actual tab implementations register loaders; the shared button does not remount tabs or clear filters', () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  for (const label of ['گزارش روزانه', 'گزارش بازه', 'گزارش گوگل ادز', 'قراردادها', 'استخراج شماره', 'بودجه و نرخ', 'تنظیمات و وضعیت اتصال']) assert.ok(source.includes(`manualRefresh.register("${label}"`), label);
  assert.ok(source.includes('onClick={() => void handleManualRefresh()} disabled={isRefreshing}'));
  assert.ok(source.includes('if (!preserveFilters)'));
  assert.ok(source.includes('if (budgetDirty.current) throw new Error'));
  assert.ok(source.includes('setEditing(current => current.id !== id ? current : { ...current, sheetStatus: latest.sheetStatus'));
});

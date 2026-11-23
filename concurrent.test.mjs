import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './rules.mjs';
import { createTicketCloser, TicketClosureError } from './close-ticket.mjs';
import { parseConcurrentArgs, allocateTickets, bindAssignedWorkflow, runConcurrentBatches } from './concurrent.mjs';

const ids = count => Array.from({ length: count }, (_, index) => `IT-${count - index}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('新命令独立解析并发参数，串行入口保持原行为', () => {
  assert.deepEqual(parseConcurrentArgs([]), { workers: 2, submit: false, headless: false, max: null, maxScan: null });
  assert.deepEqual(parseConcurrentArgs(['--workers', '3', '--submit', '--max', '100', '--max-scan', '100']),
    { workers: 3, submit: true, headless: false, max: 100, maxScan: 100 });
  assert.equal(parseConcurrentArgs(['--headless', '--submit']).headless, true);
  assert.equal(parseArgs(['run', '--submit', '--max', '100']).max, 100);
  assert.throws(() => parseArgs(['run', '--workers', '3']), /未知参数/);
  for (const args of [
    ['--workers', '0'], ['--workers', '-1'], ['--workers', '1.5'], ['--workers'],
    ['--workers', '2', '--workers', '3'], ['--submit', '--dry-run'],
    ['--headless'], ['--ticket', 'IT-1'], ['--max', 'Infinity'],
  ]) assert.throws(() => parseConcurrentArgs(args));
});

test('整除时平均分配连续倒序片段，不使用随机数', () => {
  const allocation = allocateTickets(ids(36), 4, () => { throw new Error('不应随机'); });
  assert.deepEqual(allocation.assignments.map(group => group.ids.length), [9, 9, 9, 9]);
  assert.equal(allocation.extraWorker, null);
  assert.deepEqual(allocation.assignments.flatMap(group => group.ids), ids(36));
});

test('余数全部随机分给一个页面，每个页面都可能被选中', () => {
  for (let selected = 0; selected < 3; selected++) {
    const allocation = allocateTickets(ids(20), 3, workers => { assert.equal(workers, 3); return selected; });
    assert.equal(allocation.base, 6);
    assert.equal(allocation.remainder, 2);
    assert.equal(allocation.extraWorker, selected + 1);
    assert.deepEqual(allocation.assignments.map(group => group.ids.length), [0, 1, 2].map(index => index === selected ? 8 : 6));
    assert.deepEqual(allocation.assignments.flatMap(group => group.ids), ids(20));
  }
});

test('工单少于 workers 自动串行，不调用随机分配；空队列不启动页面', async () => {
  const allocation = allocateTickets(ids(2), 5, () => { throw new Error('串行不应随机'); });
  assert.equal(allocation.requestedWorkers, 5);
  assert.equal(allocation.workers, 1);
  assert.equal(allocation.mode, 'serial');
  assert.deepEqual(allocation.assignments, [{ worker: 1, ids: ['IT-2', 'IT-1'] }]);
  const empty = allocateTickets([], 3);
  assert.equal(empty.mode, 'empty');
  assert.equal(empty.workers, 0);
  const result = await runConcurrentBatches(empty.assignments, { createWorker: () => { throw new Error('不应启动'); } });
  assert.deepEqual(result, { submitted: 0, prepared: 0, results: [], errors: [] });
});

test('一单三 workers 为串行，工单数等于 workers 仍按并发分配', () => {
  const one = allocateTickets(['IT-1'], 3);
  assert.equal(one.mode, 'serial');
  assert.deepEqual(one.assignments, [{ worker: 1, ids: ['IT-1'] }]);
  const equal = allocateTickets(ids(3), 3);
  assert.equal(equal.mode, 'concurrent');
  assert.equal(equal.workers, 3);
  assert.deepEqual(equal.assignments.map(group => group.ids.length), [1, 1, 1]);
});

test('回退后只创建一个页面并按原倒序逐单完成，不重读列表', async () => {
  const allocation = allocateTickets(ids(2), 3);
  let pages = 0, active = 0, peak = 0;
  const visited = [];
  const result = await runConcurrentBatches(allocation.assignments, {
    submit: true,
    async createWorker() {
      pages++;
      return { async closeTicket(id) {
        active++; peak = Math.max(peak, active); visited.push(id);
        await delay(2);
        active--;
        return { id, outcome: 'resolved' };
      } };
    },
  });
  assert.equal(pages, 1);
  assert.equal(peak, 1);
  assert.deepEqual(visited, ['IT-2', 'IT-1']);
  assert.equal(result.submitted, 2);
  assert.equal(result.errors.length, 0);
});

test('无效分配参数和重复工单必须拒绝', () => {
  assert.throws(() => allocateTickets(['IT-1', '1'], 2), /重复工单/);
  assert.throws(() => allocateTickets(ids(2), 0), /正整数/);
  assert.throws(() => allocateTickets(ids(5), 3, () => 3), /越界/);
});

test('多个任务真正并发，且全局 max 不会被同时完成的提交突破', { timeout: 3000 }, async () => {
  const allocation = allocateTickets(ids(9), 3);
  const barrier = deferred(), starts = [];
  const result = await runConcurrentBatches(allocation.assignments, {
    submit: true, max: 3,
    async createWorker(group) {
      return { async closeTicket(id, options) {
        assert.equal(options.source, 'alarm');
        assert.equal(options.submit, true);
        starts.push([group.worker, id]);
        if (starts.length === 3) barrier.resolve();
        await barrier.promise;
        return { id, outcome: 'resolved' };
      } };
    },
  });
  assert.equal(result.submitted, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(starts.length, 3);
  assert.equal(new Set(starts.map(([worker]) => worker)).size, 3);
});

test('默认提交模式不限制数量，所有页面并行启动并完成各自完整队列', { timeout: 3000 }, async () => {
  const assignments = allocateTickets(ids(12), 3).assignments;
  const barrier = deferred(), startedWorkers = new Set(), completed = [];
  const result = await runConcurrentBatches(assignments, {
    submit: true,
    async createWorker(group) { return { async closeTicket(id) {
      startedWorkers.add(group.worker);
      if (startedWorkers.size === 3) barrier.resolve();
      await barrier.promise;
      completed.push(id);
      return { id, outcome: 'resolved' };
    } }; },
  });
  assert.equal(result.submitted, 12);
  assert.equal(result.errors.length, 0);
  assert.equal(new Set(completed).size, 12);
});

test('跳过工单释放名额；小于 max 时完成全部分配，不互相领取', async () => {
  const allocation = allocateTickets(ids(8), 3, () => 1);
  const seen = new Set(), perWorker = new Map();
  const result = await runConcurrentBatches(allocation.assignments, {
    submit: true, max: 100,
    async createWorker(group) {
      const visited = [];
      perWorker.set(group.worker, visited);
      return { async closeTicket(id) {
        assert.ok(group.ids.includes(id));
        assert.equal(seen.has(id), false);
        seen.add(id); visited.push(id);
        await delay(2);
        return { id, outcome: Number(id.slice(3)) % 2 ? 'skipped' : 'resolved' };
      } };
    },
  });
  assert.equal(result.submitted, 4);
  assert.equal(seen.size, 8);
  for (const group of allocation.assignments) assert.deepEqual(perWorker.get(group.worker), group.ids);
});

test('max=1 时跳过不消耗成功配额，直到找到一个符合条件的工单', async () => {
  const allocation = allocateTickets(ids(6), 2);
  let success = false;
  const result = await runConcurrentBatches(allocation.assignments, {
    submit: true, max: 1,
    async createWorker() { return { async closeTicket(id) {
      await delay(1);
      const outcome = id === 'IT-5' || id === 'IT-2' ? 'resolved' : 'skipped';
      if (outcome === 'resolved') { assert.equal(success, false); success = true; }
      return { id, outcome };
    } }; },
  });
  assert.equal(result.submitted, 1);
  assert.equal(result.errors.length, 0);
});

test('预演每个页面找到第一个符合条件的工单后停留，不提交', async () => {
  const allocation = allocateTickets(ids(6), 2);
  const result = await runConcurrentBatches(allocation.assignments, {
    async createWorker(group) { return { async closeTicket(id, options) {
      assert.equal(options.submit, false);
      return { id, outcome: id === group.ids[0] ? 'skipped' : 'prepared' };
    } }; },
  });
  assert.equal(result.prepared, 2);
  assert.equal(result.submitted, 0);
  assert.equal(result.results.length, 4);
});

test('一页失败停止新单，但等待其它已经在提交的任务核验结束', { timeout: 3000 }, async () => {
  const allocation = allocateTickets(ids(4), 2);
  const barrier = deferred(), starts = [];
  let drained = false;
  const result = await runConcurrentBatches(allocation.assignments, {
    submit: true, max: 4,
    async createWorker(group, isStopped) { return { async closeTicket(id) {
      starts.push(id);
      if (starts.length === 2) barrier.resolve();
      await barrier.promise;
      if (group.worker === 1) throw new TicketClosureError(id, 'submit_attempt', new Error('提交结果未知'));
      await delay(30); // Simulate a Confirm already sent on the other page.
      assert.equal(isStopped(), true);
      drained = true;
      return { id, outcome: 'resolved' };
    } }; },
  });
  assert.equal(drained, true);
  assert.equal(starts.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].outcomeUnknown, true);
  assert.equal(result.submitted, 1);
});

test('页面启动失败唤醒等待全局配额的任务，不挂起', { timeout: 3000 }, async () => {
  const result = await runConcurrentBatches(allocateTickets(ids(6), 3).assignments, {
    submit: true, max: 1,
    async createWorker(group, isStopped) {
      if (group.worker === 3) throw new Error('页面启动失败');
      return { async closeTicket(id) { await delay(10); if (isStopped()) throw new Error('已停止'); return { id, outcome: 'resolved' }; } };
    },
  });
  assert.ok(result.errors.length >= 1);
  assert.ok(result.submitted <= 1);
});

test('分配页面只处理自己的编号，批量详情规则和提交前复查仍复用', async () => {
  const calls = [];
  let stopped = false;
  const ticket = { id: 'IT-1', status: 'In progress', subject: '121G-VSPOKE', planned: { present: false, value: '' } };
  const original = {
    log: async () => {}, capture: async () => null,
    openTicket: async (id, options) => { calls.push(['open', id, options.source]); return true; },
    readTicket: async (_, options) => { calls.push(['read', options.includeAlertStatus]); return ticket; },
    fillResolution: async () => calls.push(['fill']), verifyResolution: async () => calls.push(['verify']),
    confirmResolution: async () => { calls.push(['confirm']); return { id: 'IT-1', status: 'Resolved', resolvedDate: '2026-11-05 23:00:00' }; },
  };
  const assigned = bindAssignedWorkflow(original, ['IT-1'], () => stopped);
  assert.equal(await assigned.openTicket('IT-2', { source: 'alarm' }), false);
  assert.equal(calls.length, 0);
  assert.equal((await createTicketCloser(assigned)('IT-1', { submit: true, source: 'alarm' })).outcome, 'resolved');
  assert.deepEqual(calls.filter(call => call[0] === 'read'), [['read', false], ['read', false]]);
  assert.deepEqual(calls[0], ['open', 'IT-1', 'direct']);
  assert.equal(calls.filter(call => call[0] === 'confirm').length, 1);
  stopped = true;
  await assert.rejects(assigned.confirmResolution('IT-1'), /其它并发任务已停止/);
  assert.equal(calls.filter(call => call[0] === 'confirm').length, 1);
});

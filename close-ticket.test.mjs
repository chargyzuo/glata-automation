import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicketCloser, TicketClosureError, closeTicket, reportUnclassifiedPlanned } from './close-ticket.mjs';
import { parseArgs } from './rules.mjs';

const id = 'IT-50773309';
const eligible = { id, status: 'In progress', alertStatus: 'Recovered',
  subject: 'CNXIY17-F05-M-F121G-SPOKE01', planned: { present: false, value: '' } };

function fakeWorkflow({ initial = eligible, fresh = initial, confirmed, submitError, found = true, fillError } = {}) {
  const calls = [];
  let reads = 0;
  const workflow = {
    log: async event => calls.push(event),
    openTicket: async (ticketId, options) => { calls.push(['open', ticketId, options.source]); return found; },
    readTicket: async (_, options) => { calls.push('read', ['read_options', options]); return reads++ ? fresh : initial; },
    fillResolution: async () => { calls.push('fill'); if (fillError) throw fillError; },
    fillPlannedResolution: async (id, decision) => calls.push(['planned_fill', id, decision]),
    verifyResolution: async () => calls.push('verify'),
    confirmResolution: async () => {
      calls.push('confirm');
      if (submitError) throw submitError;
      return confirmed ?? { ...eligible, status: 'Resolved', resolvedDate: '2026-11-05 22:00:00' };
    },
    capture: async () => 'proof.jpg',
  };
  return { calls, close: createTicketCloser(workflow) };
}

test('关单函数可导入，导入时不会启动浏览器', () => {
  assert.equal(typeof closeTicket, 'function');
});

test('计划变更单按分析分流，仍检查恢复状态和提交前分析内容', async () => {
  for (const [detail, decision] of [['联通线路割接', 'eligible_planned_wan'], ['POWER 检修', 'eligible_planned_ups']]) {
    const initial = { ...eligible, subject: '其他告警', planned: {
      present: true, value: '存在一个相关的计划内事件。' + detail,
    } };
    const preview = fakeWorkflow({ initial });
    assert.equal((await preview.close(id)).outcome, 'prepared');
    assert.deepEqual(preview.calls.find(call => call[0] === 'planned_fill'), ['planned_fill', id, decision]);
    assert.equal(preview.calls.includes('confirm'), false);
    const changed = fakeWorkflow({ initial, fresh: { ...initial, planned: {
      ...initial.planned, value: initial.planned.value + '。变更内容更新。',
    } } });
    await assert.rejects(changed.close(id, { submit: true }), /提交前工单或条件发生变化/);
    assert.equal(changed.calls.includes('confirm'), false);
    const unrecovered = fakeWorkflow({ initial: { ...initial, alertStatus: 'Open' } });
    assert.equal((await unrecovered.close(id, { submit: true })).reason, 'skip_not_recovered');
    assert.equal(unrecovered.calls.some(call => call[0] === 'planned_fill'), false);
  }
});

test('无法分类的变更工单跳过并生成编号汇总', async () => {
  const results = [];
  for (const [detail, reason] of [['设备升级', 'skip_planned_unclassified'], ['线路和电源', 'skip_planned_ambiguous']]) {
    const { close, calls } = fakeWorkflow({ initial: { ...eligible, planned: {
      present: true, value: '存在一个相关的计划内事件。' + detail,
    } } });
    const result = await close(id, { submit: true, source: 'alarm' });
    assert.equal(result.reason, reason);
    assert.equal(calls.some(call => call[0] === 'planned_fill' || call === 'confirm'), false);
    results.push(result);
  }
  const events = [];
  await reportUnclassifiedPlanned(results, (...args) => events.push(args));
  assert.deepEqual(events, [['planned_change_skips', {
    count: 2, tickets: results.map(({ id, reason }) => ({ id, reason })),
  }]]);
});

test('编号分支只打开指定编号，预演不进入 Confirm', async () => {
  const { close, calls } = fakeWorkflow();
  const result = await close('50773309');
  assert.equal(result.outcome, 'prepared');
  assert.deepEqual(calls[0], ['open', id, 'direct']);
  assert.equal(calls.includes('confirm'), false);
});

test('单单和批量使用同一函数，明确提交时只 Confirm 一次并返回已解决', async () => {
  for (const source of ['direct', 'alarm']) {
    const { close, calls } = fakeWorkflow();
    assert.equal((await close(id, { submit: true, source })).outcome, 'resolved');
    assert.equal(calls.filter(call => call === 'confirm').length, 1);
    assert.equal(calls.filter(call => call === 'read').length, 2);
    assert.ok(calls.indexOf('verify') < calls.indexOf('confirm'));
  }
});

test('已解决、计划事件、设备不匹配均不会触发填写或提交', async () => {
  for (const initial of [
    { ...eligible, status: 'Closed' },
    { ...eligible, planned: { present: true, value: 'IT-50425247' } },
    { ...eligible, subject: 'S5731-AVSW08' },
  ]) {
    const { close, calls } = fakeWorkflow({ initial });
    const result = await close(id, { submit: true });
    assert.ok(['skipped', 'already_finished'].includes(result.outcome));
    assert.equal(calls.includes('fill'), false);
    assert.equal(calls.includes('confirm'), false);
  }
});

test('单号分支必须恢复，批量分支仍不读取或判断恢复状态', async () => {
  for (const alertStatus of ['Open', undefined]) {
    const initial = { ...eligible, alertStatus };
    const direct = fakeWorkflow({ initial });
    assert.equal((await direct.close(id, { submit: true })).reason, 'skip_not_recovered');
    assert.equal(direct.calls.includes('fill'), false);
    assert.deepEqual(direct.calls.find(call => Array.isArray(call) && call[0] === 'read_options'),
      ['read_options', { includeAlertStatus: true }]);
    const batch = fakeWorkflow({ initial });
    assert.equal((await batch.close(id, { source: 'alarm' })).outcome, 'prepared');
    assert.deepEqual(batch.calls.find(call => Array.isArray(call) && call[0] === 'read_options'),
      ['read_options', { includeAlertStatus: false }]);
  }
});

test('提交前条件改变或工单编号不一致时停止', async () => {
  for (const fresh of [{ ...eligible, status: 'Pending' }, { ...eligible, id: 'IT-999' },
    { ...eligible, alertStatus: 'Open' }, { ...eligible, subject: 'R450-GW01: GW Tunnel Down' }]) {
    const { close, calls } = fakeWorkflow({ fresh });
    await assert.rejects(close(id, { submit: true }), error =>
      error instanceof TicketClosureError && error.phase === 'recheck' && !error.outcomeUnknown);
    assert.equal(calls.includes('confirm'), false);
  }
});

test('AI 等待或填表失败不会提交', async () => {
  const { close, calls } = fakeWorkflow({ fillError: new Error('未确认本次 AI 自动填充完成') });
  await assert.rejects(close(id, { submit: true }), error => error.phase === 'fill');
  assert.equal(calls.includes('confirm'), false);
});

test('提交结果未知时只尝试一次，并标记结果未知', async () => {
  const { close, calls } = fakeWorkflow({ submitError: new Error('网络超时') });
  await assert.rejects(close(id, { submit: true }), error =>
    error.phase === 'submit_attempt' && error.outcomeUnknown);
  assert.equal(calls.filter(call => call === 'confirm').length, 1);
});

test('提交后未解决或返回另一张工单时不能报告成功', async () => {
  for (const confirmed of [
    { ...eligible, resolvedDate: '--' },
    { ...eligible, id: 'IT-999', status: 'Resolved', resolvedDate: '2026-11-05' },
  ]) {
    const { close } = fakeWorkflow({ confirmed });
    await assert.rejects(close(id, { submit: true }), error => error.outcomeUnknown);
  }
});

test('单号命令默认提交；dry-run、参数冲突与批量隔离', () => {
  assert.deepEqual(parseArgs(['close', '50773309']), {
    command: 'close', ticket: id, submit: true, headless: false, max: null, maxScan: null,
  });
  assert.equal(parseArgs(['close', id, '--dry-run']).submit, false);
  assert.equal(parseArgs(['run']).submit, false);
  for (const args of [
    ['close'], ['close', id, '--ticket', '999'], ['close', id, '--max', '5'],
    ['close', id, '--dry-run', '--submit'], ['close', id, '--dry-run', '--headless'],
  ]) assert.throws(() => parseArgs(args));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { captureUnrecovered, withUnrecoveredGuard } from './unrecovered.mjs';
import { createTicketCloser } from './close-ticket.mjs';

const snapshot = ids => ({ view: 'Alarm_unrecovered', viewId: '49788', total: ids.length, ids });
const eligible = { id: 'IT-1', status: 'In progress', alertStatus: 'Recovered',
  subject: '121G-VSPOKE', planned: { present: false, value: '' } };
function fixture() {
  const calls = [];
  return { calls, workflow: {
    log: async event => calls.push(event),
    openTicket: async () => { calls.push('open'); return true; },
    readTicket: async () => { calls.push('read'); return eligible; },
    fillResolution: async () => calls.push('fill'), verifyResolution: async () => calls.push('verify'),
    confirmResolution: async () => { calls.push('confirm'); return { id: 'IT-1', status: 'Resolved', resolvedDate: '2026-11-05 23:00:00' }; },
    capture: async () => null,
  } };
}

test('两视图重叠时，未恢复列表优先，串行/并发/单号均在开单前跳过', async () => {
  for (const source of ['alarm', 'direct']) {
    const { calls, workflow } = fixture();
    const close = createTicketCloser(withUnrecoveredGuard(workflow, snapshot(['IT-1'])));
    const result = await close('IT-1', { submit: true, source });
    assert.equal(result.reason, 'skip_unrecovered_snapshot');
    assert.equal(result.opened, false);
    for (const action of ['open', 'read', 'fill', 'confirm']) assert.equal(calls.includes(action), false);
  }
});

test('未恢复列表为空或不含目标时仍执行原有详情及提交前复查', async () => {
  for (const ids of [[], ['IT-2']]) {
    const { calls, workflow } = fixture();
    const close = createTicketCloser(withUnrecoveredGuard(workflow, snapshot(ids)));
    assert.equal((await close('IT-1', { submit: true, source: 'alarm' })).outcome, 'resolved');
    assert.equal(calls.filter(action => action === 'read').length, 2);
    assert.equal(calls.filter(action => action === 'confirm').length, 1);
  }
});

test('缺失/不完整/重复的未恢复列表不得当成空列表', () => {
  const { workflow } = fixture();
  for (const invalid of [undefined, {}, { ...snapshot([]), view: 'Alarm_recovered' },
    { ...snapshot(['IT-1']), total: 2 }, snapshot(['IT-1', '1']), snapshot(['invalid'])]) {
    assert.throws(() => withUnrecoveredGuard(workflow, invalid));
  }
});

test('排除集合不随原始数组修改，提交前也再次执行排除检查', async () => {
  const { workflow, calls } = fixture();
  const original = snapshot(['IT-1']);
  const guarded = withUnrecoveredGuard(workflow, original);
  original.ids.length = 0;
  assert.equal(guarded.isUnrecovered('IT-1'), true);
  let checks = 0;
  const close = createTicketCloser({ ...workflow, isUnrecovered: () => ++checks > 1 });
  await assert.rejects(close('IT-1', { submit: true, source: 'alarm' }), /命中未恢复列表/);
  assert.equal(checks, 2);
  assert.equal(calls.includes('confirm'), false);
});

const pageHTML = total => `<a href="/">Service Desk</a><aside><div>All Views</div><button>Alarm_unrecovered</button></aside>
<main><div>Alarm_unrecovered</div><table><tr><th>Ticket ID</th><th>Subject</th></tr>
<tr><td id="ticket">IT-1</td><td>test subject</td></tr></table><div>Total: ${total}</div>
<ul><li aria-label="page 1" aria-current="page">1</li><li aria-label="Go to next page">next</li></ul></main>
<script>document.querySelector('[aria-label="Go to next page"]').onclick = function () {
 document.querySelector('#ticket').textContent = 'IT-2';
 document.querySelector('[aria-label="page 1"]').removeAttribute('aria-current');
 this.setAttribute('aria-disabled', 'true');
};</script>`;

test('未恢复列表完整分页、持久化及读取失败停止', async t => {
  const browser = await chromium.launch({ headless: true });
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'glata-unrecovered-'));
  try {
    await t.test('完整读取所有页后才保存排除列表', async () => {
      const page = await browser.newPage();
      await page.route('https://glata.bytedance.net/**', route => route.fulfill({ contentType: 'text/html', body: pageHTML(2) }));
      const result = await captureUnrecovered(page, { artifactDir });
      assert.deepEqual(result.ids, ['IT-1', 'IT-2']);
      assert.equal(result.total, 2);
      const saved = JSON.parse(await readFile(path.join(artifactDir, 'unrecovered-snapshot.json'), 'utf8'));
      assert.deepEqual(saved, result);
      await page.close();
    });
    await t.test('缺页时抛错，不返回空排除列表或不完整列表', async () => {
      const page = await browser.newPage();
      await page.route('https://glata.bytedance.net/**', route => route.fulfill({ contentType: 'text/html', body: pageHTML(99) }));
      await assert.rejects(captureUnrecovered(page), /提取数量不一致/);
      await page.close();
    });
  } finally {
    await browser.close();
    await rm(artifactDir, { recursive: true, force: true });
  }
});

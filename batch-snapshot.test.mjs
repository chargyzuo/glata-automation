import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createGlataWorkflow } from './workflow.mjs';
import { DEFAULT_VIEW } from './views.mjs';

const tickets = [1, 2, 3].map(number => ({ id: `IT-${number}`, subject: `Subject ${number}` }));
const listHTML = `<main><div>${DEFAULT_VIEW.name}</div><table>
  <tr><th>Ticket ID</th><th>Subject</th></tr>
  ${tickets.map(ticket => `<tr><td>${ticket.id}</td><td>${ticket.subject}</td></tr>`).join('')}
  </table><div>Total: 3</div><ul>
  <li aria-label="page 1" aria-current="page">1</li>
  <li aria-label="Go to next page" aria-disabled="true">next</li></ul></main>`;

test('批量从一次列表快照倒序打开，多单之间不再读取列表', async t => {
  const browser = await chromium.launch({ headless: true });
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'glata-queue-test-'));
  try {
    await t.test('背景资源持续加载时仍按目标工单 DOM 打开，串行与并发适用', async () => {
      for (const source of ['direct', 'alarm']) {
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(1500);
        let finishImage;
        const imageDone = new Promise(resolve => { finishImage = resolve; });
        try {
          await page.route('**/blocked-image.png', async route => {
            await imageDone;
            await route.abort().catch(() => {});
          });
          await page.route('**/ens/engineer/ticketView?*', route => route.fulfill({
            contentType: 'text/html',
            body: '<div role="tabpanel" aria-label="Details">IT-3</div><img src="/blocked-image.png">',
          }));
          const workflow = createGlataWorkflow(page);
          if (source === 'alarm') {
            await page.setContent(listHTML);
            await workflow.snapshotQueue();
          }
          assert.equal(await workflow.openTicket('IT-3', { source }), true);
          await assert.rejects(page.waitForLoadState('load', { timeout: 200 }), /Timeout/);
          assert.equal(await page.getByRole('tabpanel').innerText(), 'IT-3');
        } finally {
          finishImage();
          await page.close();
        }
      }
    });
    await t.test('保存完整名称列表，倒序后限制数量，并逐单直达详情', async () => {
      const page = await browser.newPage();
      const visits = [], events = [];
      await page.route('https://glata.bytedance.net/**', async route => {
        const seq = new URL(route.request().url()).searchParams.get('seq');
        visits.push(seq);
        // Deliberately no list or search box: subsequent opens must use saved IDs.
        await route.fulfill({ contentType: 'text/html', body: `<div role="tabpanel" aria-label="Details">IT-${seq}</div>` });
      });
      await page.setContent(listHTML);
      const workflow = createGlataWorkflow(page, { artifactDir, log: async event => events.push(event) });
      assert.deepEqual(await workflow.snapshotQueue({ maxScan: 2 }), ['IT-3', 'IT-2']);
      const saved = JSON.parse(await readFile(path.join(artifactDir, 'queue-snapshot.json'), 'utf8'));
      assert.equal(saved.view, 'Alarm_recovered');
      assert.equal(saved.total, 3);
      assert.deepEqual(saved.tickets, tickets);
      assert.deepEqual(saved.ids, ['IT-3', 'IT-2']);
      // Remove the live list entirely; a saved ticket remains available to this run.
      await page.setContent('<main>No data</main>');
      for (const id of saved.ids) assert.equal(await workflow.openTicket(id, { source: 'alarm' }), true);
      assert.deepEqual(visits, ['3', '2']);
      assert.equal(events.filter(event => event === 'alarm_subjects_page').length, 1);
      for (const id of ['IT-1', 'IT-4']) assert.equal(await workflow.openTicket(id, { source: 'alarm' }), false);
      assert.deepEqual(visits, ['3', '2']);
      // A failed new snapshot must not leave the old queue authorized.
      await assert.rejects(workflow.snapshotQueue({ maxScan: 0 }), /maxScan/);
      await assert.rejects(workflow.openTicket('IT-3', { source: 'alarm' }), /必须先读取/);
      await page.close();
    });
    await t.test('批量必须先建队列，指定编号也必须属于初始快照', async () => {
      const page = await browser.newPage();
      const workflow = createGlataWorkflow(page);
      await assert.rejects(workflow.openTicket('IT-1', { source: 'alarm' }), /必须先读取/);
      await page.setContent(listHTML);
      assert.deepEqual(await workflow.snapshotQueue({ ticket: 'IT-4' }), []);
      assert.equal(await workflow.openTicket('IT-4', { source: 'alarm' }), false);
      assert.deepEqual(await workflow.snapshotQueue({ ticket: 'IT-2' }), ['IT-2']);
      await page.close();
    });
    await t.test('单号直达入口无需批量快照', async () => {
      const page = await browser.newPage();
      await page.route('https://glata.bytedance.net/**', route => route.fulfill({
        contentType: 'text/html', body: '<div role="tabpanel" aria-label="Details">IT-9</div>',
      }));
      assert.equal(await createGlataWorkflow(page).openTicket('IT-9'), true);
      await page.close();
    });
  } finally {
    await browser.close();
    await rm(artifactDir, { recursive: true, force: true });
  }
});

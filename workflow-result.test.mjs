import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createGlataWorkflow } from './workflow.mjs';
import { checkAlertRecovered } from './archive/alert-status.mjs';

const id = 'IT-50773309';
const finishedHTML = `<section><div class="button_group"><button>Edit</button></div><span id="status">Resolved</span>
<div role="tabpanel" aria-label="Details"><div><div>Ticket ID</div><div>${id}</div></div>
<div><div>Resolved Date</div><div>2026-11-05 22:26:22</div></div></div></section>`;

test('解决后的核验不依赖平台已移除的 Alert Status', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    await t.test('处理中页面没有 Alert Status 时仍可读取关单条件', async () => {
      const page = await browser.newPage();
      await page.setContent(finishedHTML.replace('>Resolved</span>', '>In progress</span>')
        .replace('<section>', '<section><div class="ticket-detail-header-title-text-aPNfxQ" style="max-width:50px;overflow:hidden;white-space:nowrap">CNXIY17-F05-M-F121G-SPOKE01</div>')
        .replace('</div></section>', '<div><div>Description</div><div>CNXIY17-F05-M-F121G-SPOKE01</div></div><div><div>Alert Detail</div><div>详情</div></div></div></section>'));
      const ticket = await createGlataWorkflow(page).readTicket(id);
      assert.equal(ticket.status, 'In progress');
      assert.equal(ticket.description, 'CNXIY17-F05-M-F121G-SPOKE01');
      assert.equal(ticket.subject, 'CNXIY17-F05-M-F121G-SPOKE01');
      assert.equal(Object.hasOwn(ticket, 'alertStatus'), false);
      await page.close();
    });
    await t.test('读取当前标题变化且不依赖 Description 内容', async () => {
      const page = await browser.newPage();
      await page.setContent(`<section><div class="button_group"></div><span>In progress</span>
        <div class="ticket-detail-header-title-text-aPNfxQ">INTERNET-A_[Baseline-Net]-ISP Down</div>
        <div role="tabpanel" aria-label="Details"><div><div>Ticket ID</div><div>${id}</div></div>
        <div>Alert Detail</div></div></section>`);
      const workflow = createGlataWorkflow(page);
      assert.equal((await workflow.readTicket(id)).subject, 'INTERNET-A_[Baseline-Net]-ISP Down');
      await page.locator('.ticket-detail-header-title-text-aPNfxQ').evaluate(el => { el.textContent = 'R450-GW01: GW Tunnel Down'; });
      const fresh = await workflow.readTicket(id);
      assert.equal(fresh.subject, 'R450-GW01: GW Tunnel Down');
      assert.equal(fresh.description, '');
      await page.close();
    });
    await t.test('存档的 DOM 恢复状态读取函数仍可显式调用', async () => {
      const page = await browser.newPage();
      await page.setContent('<div role="tabpanel" aria-label="Details"><div><div>Alert Status</div><div>Recovered</div></div></div>');
      assert.equal(await checkAlertRecovered(page), true);
      await page.getByText('Recovered', { exact: true }).evaluate(el => { el.textContent = 'Open'; });
      assert.equal(await checkAlertRecovered(page), false);
      await page.close();
    });
    await t.test('已解决页面没有告警字段时仍能读到状态和解决时间', async () => {
      const page = await browser.newPage();
      await page.setContent(finishedHTML);
      const workflow = createGlataWorkflow(page);
      assert.deepEqual(await workflow.readTicket(id), { id, status: 'Resolved' });
      assert.deepEqual(await workflow.readResolutionResult(id), {
        id, status: 'Resolved', resolvedDate: '2026-11-05 22:26:22',
      });
      await page.close();
    });
    await t.test('Confirm 后移除告警字段仍能完成核验，且仅点击一次', async () => {
      const page = await browser.newPage();
      await page.setContent(`${finishedHTML.replace('>Resolved</span>', '>In progress</span>')}
        <div role="dialog" aria-label="Resolve"><button id="confirm">Confirm</button></div>`);
      await page.locator('#confirm').evaluate(el => {
        window.confirmCount = 0;
        el.onclick = () => {
          window.confirmCount++;
          document.querySelector('#status').textContent = 'Resolved';
          document.querySelector('[role="dialog"]').remove();
        };
      });
      const result = await createGlataWorkflow(page).confirmResolution(id);
      assert.equal(result.status, 'Resolved');
      assert.equal(result.resolvedDate, '2026-11-05 22:26:22');
      assert.equal(await page.evaluate(() => window.confirmCount), 1);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});

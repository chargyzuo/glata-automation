import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForDomReady } from './dom-ready.mjs';
import { createGlataWorkflow } from './workflow.mjs';

test('DOM 就绪不依赖后台请求停止，并保留内容加载门槛', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    await t.test('后台持续轮询时列表仍可读取', async () => {
      const page = await browser.newPage();
      let requests = 0;
      await page.route('https://poll.test/**', async route => {
        requests++;
        await route.fulfill({ body: '{}', headers: { 'access-control-allow-origin': '*' } });
      });
      await page.setContent('<main><table><tr><th>Ticket ID</th><th>Subject</th></tr><tr><td>IT-1</td><td>name</td></tr></table><div>Total: 1</div></main>');
      await page.evaluate(() => { window.poll = setInterval(() => fetch('https://poll.test/status').catch(() => {}), 50); });
      await waitForDomReady(page.getByRole('main'), { mode: 'list', stableMs: 300, timeoutMs: 3000 });
      assert.ok(requests >= 3);
      await assert.rejects(page.waitForLoadState('networkidle', { timeout: 300 }), /Timeout/);
      await page.close();
    });
    await t.test('加载中的详情不能提前把计划事件字段判为空', async () => {
      const page = await browser.newPage();
      await page.setContent(`<section><div class="button_group"></div><span>In progress</span>
        <div class="ticket-detail-header-title-text-aPNfxQ">121G-VSPOKE</div>
        <div role="tabpanel" aria-label="Details" aria-busy="true">
        <div><div>Ticket ID</div><div>IT-1</div></div>
        <div><div>Description</div><div>121G-VSPOKE</div></div><div>Alert Detail</div></div></section>`);
      await page.evaluate(() => setTimeout(() => {
        const panel = document.querySelector('[role="tabpanel"]');
        panel.insertAdjacentHTML('beforeend', '<div><div>Monisight AI Planned Event Analysis</div><div>planned maintenance</div></div>');
        panel.removeAttribute('aria-busy');
      }, 1200));
      const result = await createGlataWorkflow(page).readTicket('IT-1');
      assert.equal(result.planned.present, true);
      assert.equal(result.planned.value, 'planned maintenance');
      await page.close();
    });
    await t.test('有 Total 但无数据行或空列表标识时超时', async () => {
      const page = await browser.newPage();
      await page.setContent('<main><table><tr><th>Ticket ID</th><th>Subject</th></tr></table><div>Total: 1</div></main>');
      await assert.rejects(waitForDomReady(page.getByRole('main'), { mode: 'list', timeoutMs: 350, stableMs: 100 }), /内容就绪超时/);
      await page.close();
    });
    await t.test('加载指示器持续可见时必须停止', async () => {
      const page = await browser.newPage();
      await page.setContent('<div role="tabpanel" aria-label="Details"><div role="progressbar">loading</div><div>Ticket ID</div><div>IT-1</div></div>');
      await assert.rejects(waitForDomReady(page.getByRole('tabpanel'), {
        nonEmptyFields: ['Ticket ID'], timeoutMs: 350, stableMs: 100,
      }), /加载指示器仍可见/);
      await page.close();
    });
  } finally { await browser.close(); }
});

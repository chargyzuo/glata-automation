import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { armAiCompletion } from './ai-ready.mjs';
import { createGlataWorkflow } from './workflow.mjs';
import { bindAssignedWorkflow } from './concurrent.mjs';

test('同一浏览器的多个页面隔离工单与 AI 完成提示', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('https://glata.bytedance.net/**', route => {
      const id = `IT-${new URL(route.request().url()).searchParams.get('seq')}`;
      return route.fulfill({ contentType: 'text/html', body: `<div role="tabpanel" aria-label="Details">${id}</div>` });
    });
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    const flows = pages.map((page, index) => bindAssignedWorkflow(createGlataWorkflow(page), [`IT-${index + 1}`]));
    await Promise.all(flows.map((flow, index) => flow.openTicket(`IT-${index + 1}`, { source: 'alarm' })));
    assert.equal(await pages[0].getByRole('tabpanel').innerText(), 'IT-1');
    assert.equal(await pages[1].getByRole('tabpanel').innerText(), 'IT-2');
    const watches = await Promise.all(pages.map(page => armAiCompletion(page, { timeoutMs: 3000 })));
    let secondCompleted = false;
    const first = watches[0].wait();
    const second = watches[1].wait().then(result => { secondCompleted = true; return result; });
    await pages[0].evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="ai-toast-text">AI form filling completed</div>'));
    assert.equal((await first).message, 'AI form filling completed');
    assert.equal(secondCompleted, false);
    await pages[1].evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="ai-toast-text">AI form filling completed</div>'));
    assert.equal((await second).message, 'AI form filling completed');
  } finally { await browser.close(); }
});

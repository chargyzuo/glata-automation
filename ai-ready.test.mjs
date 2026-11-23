import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { armAiCompletion } from './ai-ready.mjs';

test('AI 完成提示是必要门槛，且不会漏掉短暂出现的提示', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    await t.test('延迟完成前不填写，完成后才继续', async () => {
      const page = await browser.newPage();
      await page.setContent('<button>Resolve</button><input id="manual-field">');
      await page.getByRole('button', { name: 'Resolve' }).evaluate(el => {
        el.addEventListener('click', () => setTimeout(() => {
          const toast = document.createElement('span');
          toast.className = 'ai-toast-text';
          toast.textContent = 'AI form filling completed';
          document.body.append(toast);
        }, 150));
      });
      const gate = await armAiCompletion(page, { timeoutMs: 3000 });
      await page.getByRole('button', { name: 'Resolve' }).click();
      assert.equal(await page.locator('#manual-field').inputValue(), '');
      await gate.wait();
      await page.locator('#manual-field').fill('Network Issues');
      assert.equal(await page.locator('#manual-field').inputValue(), 'Network Issues');
      await page.close();
    });

    await t.test('提示已出现又消失后仍能读取本次完成信号', async () => {
      const page = await browser.newPage();
      await page.setContent('<button>Resolve</button>');
      const gate = await armAiCompletion(page, { timeoutMs: 3000 });
      await page.evaluate(() => {
        const toast = document.createElement('span');
        toast.className = 'ai-toast-text';
        toast.textContent = 'AI form filling completed';
        document.body.append(toast);
      });
      await page.locator('.ai-toast-text').waitFor({ state: 'visible' });
      await page.locator('.ai-toast-text').evaluate(el => el.remove());
      assert.equal(await page.locator('.ai-toast-text').count(), 0);
      assert.equal((await gate.wait()).message, 'AI form filling completed');
      await page.close();
    });

    await t.test('旧提示未消失时拒绝开始新一轮监听', async () => {
      const page = await browser.newPage();
      await page.setContent('<span class="ai-toast-text">AI form filling completed</span>');
      await assert.rejects(armAiCompletion(page, { staleTimeoutMs: 150 }));
      await page.close();
    });

    await t.test('没有提示或仅存在隐藏提示时超时，不执行填写', async () => {
      const page = await browser.newPage();
      await page.setContent('<span class="ai-toast-text" hidden>AI form filling completed</span><input id="manual-field">');
      const gate = await armAiCompletion(page, { timeoutMs: 200 });
      await assert.rejects(gate.wait(), /停止填写/);
      assert.equal(await page.locator('#manual-field').inputValue(), '');
      await page.close();
    });
  } finally {
    await browser.close();
  }
});

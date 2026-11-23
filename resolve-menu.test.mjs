import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openResolveMenu } from './resolve-menu.mjs';

test('Operation 菜单兼容悬停展开和点击展开，不重复切换', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    async function fixture(mode) {
      const page = await browser.newPage();
      await page.setContent('<button>Operation</button><div role="menu" hidden><div role="menuitem">Resolve</div></div>');
      await page.evaluate(mode => {
        const button = document.querySelector('button');
        const menu = document.querySelector('[role="menu"]');
        window.operationClicks = 0;
        if (mode === 'hover') button.onmouseenter = () => { menu.hidden = false; };
        if (mode === 'visible') menu.hidden = false;
        button.onclick = () => { window.operationClicks++; menu.hidden = !menu.hidden; };
      }, mode);
      return page;
    }
    await t.test('悬停已展开时不再点击触发器，避免把菜单收起', async () => {
      const page = await fixture('hover');
      assert.equal((await openResolveMenu(page)).openedBy, 'hover');
      assert.equal(await page.evaluate(() => window.operationClicks), 0);
      await page.close();
    });
    await t.test('只支持点击展开时，悬停未打开后点击一次', async () => {
      const page = await fixture('click');
      assert.equal((await openResolveMenu(page, { hoverTimeoutMs: 100 })).openedBy, 'click');
      assert.equal(await page.evaluate(() => window.operationClicks), 1);
      await page.close();
    });
    await t.test('已有可见 Resolve 选项时不重复切换菜单', async () => {
      const page = await fixture('visible');
      assert.equal((await openResolveMenu(page)).openedBy, 'already_visible');
      assert.equal(await page.evaluate(() => window.operationClicks), 0);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});

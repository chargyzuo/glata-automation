import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { extractAlarmSubjects } from './alarm-subjects.mjs';
import { parseArgs } from './rules.mjs';
import { DEFAULT_VIEW } from './views.mjs';

async function fixture(browser, {
  pages = [[{ id: 'IT-1', subject: '工单名称' }]],
  columns = ['', 'Ticket ID', 'Subject', 'Status'], startPage = 0, changedTotal = null, viewName = DEFAULT_VIEW.name,
} = {}) {
  const page = await browser.newPage();
  await page.setContent(`<main><div>${viewName}</div><table id="headers"><thead><tr></tr></thead></table><table><tbody id="rows"></tbody></table><div id="total"></div><ul id="pagination"></ul></main>`);
  await page.evaluate(({ pages, columns, startPage, changedTotal }) => {
    const total = pages.flat().length;
    let active = startPage;
    const header = document.querySelector('#headers tr');
    for (const name of columns) {
      const th = document.createElement('th');
      th.textContent = name;
      header.append(th);
    }
    const render = () => {
      const body = document.querySelector('#rows');
      body.replaceChildren();
      for (const record of pages[active]) {
        const row = document.createElement('tr');
        for (const name of columns) {
          const cell = document.createElement('td');
          cell.textContent = name === 'Ticket ID' ? record.id : name === 'Subject' ? record.subject : '';
          if (name === 'Subject') cell.style.cssText = 'max-width:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
          row.append(cell);
        }
        body.append(row);
      }
      document.querySelector('#no-data')?.remove();
      if (!pages[active].length) {
        const empty = document.createElement('div');
        empty.id = 'no-data'; empty.textContent = 'No data'; document.querySelector('main').append(empty);
      }
      document.querySelector('#total').textContent = `Total: ${changedTotal !== null && active > 0 ? changedTotal : total}`;
      const pagination = document.querySelector('#pagination');
      pagination.replaceChildren();
      pages.forEach((_, index) => {
        const item = document.createElement('li');
        item.textContent = String(index + 1);
        item.setAttribute('aria-label', `page ${index + 1}`);
        if (index === active) item.setAttribute('aria-current', 'page');
        item.onclick = () => setTimeout(() => { active = index; render(); }, 30);
        pagination.append(item);
      });
      const next = document.createElement('li');
      next.textContent = '.'; next.setAttribute('aria-label', 'Go to next page');
      next.setAttribute('aria-disabled', String(active === pages.length - 1));
      next.onclick = () => setTimeout(() => { if (active < pages.length - 1) { active++; render(); } }, 30);
      pagination.append(next);
    };
    render();
  }, { pages, columns, startPage, changedTotal });
  return page;
}

test('只读 Subject 提取支持完整分页、动态列及完整性核验', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    await t.test('Glata 隐藏 Total 时识别明确的空表格', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(`<main><div>${DEFAULT_VIEW.name}</div><table>
          <thead><tr><th>Ticket ID</th><th>Subject</th></tr></thead>
          <tbody><tr class="arco-table-empty-row"><td colspan="2">
          <div class="arco-table-no-data"><div class="arco-empty-description">No data</div></div>
          </td></tr></tbody></table></main>`);
        assert.deepEqual(await extractAlarmSubjects(page, { navigate: false }), []);
      } finally { await page.close(); }
    });
    const pages = [
      [{ id: 'IT-1', subject: '重复名称' }, { id: 'IT-2', subject: '重复名称' }],
      [{ id: 'IT-3', subject: '这是被 CSS 省略显示但必须完整提取的 VSPOKE 工单名称' }],
    ];
    await t.test('跨页读取完整 Subject，保留同名工单和原列表顺序', async () => {
      const page = await fixture(browser, { pages });
      assert.deepEqual(await extractAlarmSubjects(page, { navigate: false }), pages.flat().map(row => row.subject));
      await page.close();
    });
    await t.test('按表头定位列，从非第一页进入也能读全，并可返回编号', async () => {
      const page = await fixture(browser, { pages, columns: ['Subject', 'Status', 'Ticket ID', ''], startPage: 1 });
      assert.deepEqual(await extractAlarmSubjects(page, { navigate: false, includeIds: true }), pages.flat());
      await page.close();
    });
    await t.test('总数为零时返回空数组', async () => {
      const page = await fixture(browser, { pages: [[]] });
      assert.deepEqual(await extractAlarmSubjects(page, { navigate: false }), []);
      await page.close();
    });
    await t.test('仍可显式读取旧 Alarm 视图', async () => {
      const page = await fixture(browser, { pages, viewName: 'Alarm' });
      assert.deepEqual(await extractAlarmSubjects(page, { navigate: false, viewName: 'Alarm', includeIds: true }), pages.flat());
      await page.close();
    });
    await t.test('跨页重复编号不能返回假完整结果', async () => {
      const page = await fixture(browser, { pages: [pages[0], [{ id: 'IT-2', subject: '重复编号' }]] });
      await assert.rejects(extractAlarmSubjects(page, { navigate: false }), /重复工单/);
      await page.close();
    });
    await t.test('提取期间总数变化时停止', async () => {
      const page = await fixture(browser, { pages, changedTotal: 999 });
      await assert.rejects(extractAlarmSubjects(page, { navigate: false }), /总数发生变化/);
      await page.close();
    });
    await t.test('页数限制不能静默截断结果', async () => {
      const page = await fixture(browser, { pages });
      await assert.rejects(extractAlarmSubjects(page, { navigate: false, maxPages: 1 }), /未返回不完整结果/);
      await page.close();
    });
    await t.test('缺少 Subject 列时停止', async () => {
      const page = await fixture(browser, { columns: ['Ticket ID', 'Name'] });
      await assert.rejects(extractAlarmSubjects(page, { navigate: false }), /Subject 列/);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});

test('subjects 命令只读，不接受提交或单号参数', () => {
  assert.equal(parseArgs(['subjects']).submit, false);
  assert.equal(parseArgs(['subjects', '--headless']).headless, true);
  for (const args of [
    ['subjects', '--submit'], ['subjects', '--ticket', '123'],
    ['subjects', '--max', '5'], ['subjects', '--dry-run'],
  ]) assert.throws(() => parseArgs(args));
});

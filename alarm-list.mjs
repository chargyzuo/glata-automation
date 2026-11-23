import { normalize } from './rules.mjs';
import { DEFAULT_VIEW, getView } from './views.mjs';
import { waitForDomReady } from './dom-ready.mjs';

const ID_PATTERN = /^IT-\d+$/;
const TOTAL_PATTERN = /^Total:\s*[\d,]+$/;

export async function collectAlarmList(page, { maxPages = 1000, viewName = DEFAULT_VIEW.name, log = async () => {} } = {}) {
  const view = getView(viewName);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('maxPages 必须为正整数');
  const main = page.getByRole('main');
  await main.getByText(view.name, { exact: true }).waitFor({ state: 'visible' });
  const idCell = id => main.getByRole('cell', { name: id, exact: true });

  async function settled() {
    return waitForDomReady(main, { mode: 'list' });
  }

  async function total() {
    const text = await main.getByText(TOTAL_PATTERN).innerText();
    const value = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isSafeInteger(value)) throw new Error('无法读取 Alarm 总数');
    return value;
  }

  async function readRows() {
    // Derive the column positions from their actual headers, including the checkbox column.
    // Do not depend on Subject always being column 3.
    const headerNames = (await main.getByRole('columnheader').allTextContents()).map(normalize);
    const idIndex = headerNames.indexOf('Ticket ID');
    const subjectIndex = headerNames.indexOf('Subject');
    if (idIndex < 0 || subjectIndex < 0 || headerNames.filter(name => name === 'Subject').length !== 1 ||
        headerNames.filter(name => name === 'Ticket ID').length !== 1) {
      throw new Error('无法唯一定位 Ticket ID / Subject 列');
    }
    const rows = main.getByRole('row').filter({ has: page.getByRole('cell', { name: ID_PATTERN }) });
    const result = [];
    for (const row of await rows.all()) {
      const cells = row.getByRole('cell');
      if (await cells.count() <= Math.max(idIndex, subjectIndex)) throw new Error('工单行列结构不完整');
      const id = normalize(await cells.nth(idIndex).innerText());
      const subject = normalize(await cells.nth(subjectIndex).innerText());
      if (!ID_PATTERN.test(id) || !subject) throw new Error('工单编号或 Subject 为空');
      result.push({ id, subject });
    }
    return result;
  }

  if (await settled()) return [];
  const firstPage = main.getByRole('listitem', { name: 'page 1', exact: true });
  if (await firstPage.count()) {
    const active = await firstPage.evaluate(el =>
      ['page', 'true'].includes(el.getAttribute('aria-current')) || el.classList.contains('arco-pagination-item-active'));
    if (!active) {
      const previous = await readRows();
      await firstPage.click();
      if (previous.length) await idCell(previous[0].id).waitFor({ state: 'hidden' });
      if (await settled()) throw new Error('提取期间 Alarm 列表变空，请重新读取');
    }
  }

  const expectedTotal = await total();
  const records = [];
  const seenIds = new Set();
  const signatures = new Set();
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    if (await settled()) throw new Error('提取期间 Alarm 列表变空，请重新读取');
    if (await total() !== expectedTotal) throw new Error('提取期间 Alarm 总数发生变化，请重新读取');
    const rows = await readRows();
    if (!rows.length) {
      if (expectedTotal === 0 && records.length === 0) return [];
      throw new Error('分页尚未加载或列表意外为空，未返回不完整结果');
    }
    const signature = rows.map(row => row.id).join(',');
    if (signatures.has(signature)) throw new Error('分页未更新，未返回重复或不完整结果');
    signatures.add(signature);
    for (const record of rows) {
      if (seenIds.has(record.id)) throw new Error(`跨页出现重复工单 ${record.id}，列表可能已变化`);
      seenIds.add(record.id);
      records.push(record);
    }
    await log('alarm_subjects_page', { view: view.name, page: pageNo, count: rows.length, collected: records.length, total: expectedTotal });
    const next = main.getByRole('listitem', { name: 'Go to next page', exact: true });
    if (await next.count() !== 1) throw new Error('无法定位下一页控件');
    const disabled = await next.evaluate(el =>
      el.getAttribute('aria-disabled') === 'true' || /disabled/.test(el.className));
    if (disabled) {
      if (records.length !== expectedTotal) throw new Error(`提取数量不一致: ${records.length} / ${expectedTotal}`);
      return records;
    }
    if (pageNo === maxPages) break;
    await next.click();
    await idCell(rows[0].id).waitFor({ state: 'hidden' });
  }
  throw new Error(`列表超过 ${maxPages} 页，未返回不完整结果`);
}

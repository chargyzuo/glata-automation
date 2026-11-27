import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { normalize, normalizeTicketId, reverseQueue } from './rules.mjs';
import { armAiCompletion } from './ai-ready.mjs';
import { collectAlarmList } from './alarm-list.mjs';
import { BASE, DEFAULT_VIEW, getView } from './views.mjs';
import { readAlertStatus } from './archive/alert-status.mjs';
import { openResolveMenu } from './resolve-menu.mjs';
import { waitForDomReady } from './dom-ready.mjs';
import { getClosureConfig } from './closure-config.mjs';

export { BASE };
export const START = DEFAULT_VIEW.url;

export function createGlataWorkflow(page, { log = async () => {}, artifactDir = null } = {}) {
  const panel = () => page.getByRole('tabpanel', { name: 'Details', exact: true });
  const dialog = () => page.getByRole('dialog', { name: 'Resolve', exact: true });
  let batchIds = null;

  async function field(label, { optional = false } = {}) {
    const locator = panel().getByText(label, { exact: true });
    const count = await locator.count();
    if (count === 0 && optional) return { present: false, value: '' };
    if (count !== 1) throw new Error(`字段 ${label} 数量异常: ${count}`);
    return locator.evaluate(el => {
      const value = el.nextElementSibling;
      if (!value) throw new Error(`字段内容节点缺失: ${el.textContent}`);
      return { present: true, value: value.innerText ?? value.textContent ?? '' };
    });
  }

  async function readTicketHeader(id) {
    await panel().getByText(id, { exact: true }).waitFor({ state: 'visible' });
    await waitForDomReady(panel(), { nonEmptyFields: ['Ticket ID'] });
    const actualId = normalize((await field('Ticket ID')).value);
    if (actualId !== id) throw new Error(`工单编号不一致: ${actualId} / ${id}`);
    // The current ticket header contains Operation. Inspect its nearest enclosing
    // header with a status badge; do not read status from an unrelated table row.
    const status = await panel().evaluate(el => {
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.querySelector('.button_group')) {
          const texts = [...ancestor.querySelectorAll('*')]
            .filter(node => node.children.length === 0)
            .map(node => node.textContent.trim());
          const candidates = [...new Set(texts.filter(text =>
            ['In progress', 'Resolved', 'Closed', 'Pending', 'To be handled', 'To be Picked Up'].includes(text)))];
          if (candidates.length === 1) return candidates[0];
          throw new Error('无法唯一识别当前工单状态');
        }
        ancestor = ancestor.parentElement;
      }
      throw new Error('当前工单标题区域结构发生变化');
    });
    return { id, status };
  }

  async function readTicket(id, { includeAlertStatus = false } = {}) {
    const header = await readTicketHeader(id);
    // Finished tickets may no longer expose any alert-specific fields.
    if (['Resolved', 'Closed'].includes(header.status)) return header;
    await panel().getByText('Alert Detail', { exact: true }).waitFor({ state: 'visible' });
    await waitForDomReady(panel(), {
      requiredFields: ['Alert Detail', ...(includeAlertStatus ? ['Alert Status'] : [])],
      nonEmptyFields: ['Ticket ID'],
    });
    // Scope to this drawer, not the background Subject table or correlated alerts.
    // This verified container exposes the full title even when CSS truncates it.
    const region = panel().locator('xpath=ancestor::*[descendant::*[contains(concat(" ", normalize-space(@class), " "), " button_group ")]][1]');
    const title = region.locator('.ticket-detail-header-title-text-aPNfxQ');
    await title.waitFor({ state: 'visible' });
    await waitForDomReady(title);
    const subject = normalize(await title.innerText());
    return {
      ...header,
      subject,
      ...(includeAlertStatus ? { alertStatus: await readAlertStatus(page) } : {}),
      description: normalize((await field('Description', { optional: true })).value),
      planned: await field('Monisight AI Planned Event Analysis', { optional: true }),
    };
  }

  async function readResolutionResult(id) {
    await panel().getByText('Resolved Date', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    await waitForDomReady(panel(), { nonEmptyFields: ['Ticket ID', 'Resolved Date'] });
    const header = await readTicketHeader(id);
    return { ...header, resolvedDate: normalize((await field('Resolved Date')).value) };
  }

  async function dismissTicket() {
    // This Close icon is the ticket drawer close control observed on the live page.
    await page.locator('button.closeIcon').click();
    await panel().waitFor({ state: 'hidden' });
  }

  async function enterAlarm({ viewName = DEFAULT_VIEW.name } = {}) {
    const view = getView(viewName);
    if (!(await page.getByRole('complementary').getByText('All Views', { exact: true }).isVisible())) {
      await page.getByRole('complementary').locator('div.route-item-YN0441')
        .filter({ has: page.locator('svg.glata-icon-side_fold') }).click();
    }
    const escapedName = view.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page.getByRole('button', { name: new RegExp(`^${escapedName}(?:\\s+\\d+)?$`) }).click();
    await page.waitForURL(url => url.origin === BASE && url.searchParams.get('viewId') === view.id);
    await page.getByRole('main').getByText(view.name, { exact: true }).waitFor({ state: 'visible' });
    await waitForDomReady(page.getByRole('main'), { mode: 'list' });
    await log('view_ready', { view: view.name, readiness: 'dom' });
  }

  async function snapshotQueue({ ticket = null, maxScan = null } = {}) {
    // Clear prior authorization before attempting a fresh complete snapshot.
    batchIds = null;
    if (maxScan !== null && (!Number.isSafeInteger(maxScan) || maxScan < 1)) throw new Error('maxScan 必须为正整数');
    const requestedId = ticket ? normalizeTicketId(ticket) : null;
    // Shared with npm run subjects; read all pages only once per batch run.
    const records = await collectAlarmList(page, { log });
    const ids = reverseQueue(records.filter(record => !requestedId || record.id === requestedId)
      .map(record => record.id), maxScan);
    const snapshot = { view: DEFAULT_VIEW.name, viewId: DEFAULT_VIEW.id,
      capturedAt: new Date().toISOString(), total: records.length, order: 'last_to_first',
      maxScan, requestedTicket: requestedId, ids, tickets: records };
    if (artifactDir) {
      const file = path.join(artifactDir, 'queue-snapshot.json');
      await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
      await log('queue_snapshot_saved', { file, total: records.length, queued: ids.length });
    }
    batchIds = new Set(ids);
    return ids;
  }

  async function openTicket(id, { source = 'direct' } = {}) {
    if (!['direct', 'alarm'].includes(source)) throw new Error('未知工单打开方式');
    if (source === 'alarm') {
      if (!batchIds) throw new Error('批量处理前必须先读取本轮 Alarm_recovered 队列');
      if (!batchIds.has(id)) return false;
    }
    // Open the saved ID directly. Do not search or re-read the live list between tickets.
    await page.goto(`${START}&seq=${id.replace(/^IT-/, '')}`, { waitUntil: 'domcontentloaded' });
    await panel().getByText(id, { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    return true;
  }

  async function fillPlannedResolution(id, decision) {
    if (!decision?.startsWith('eligible_planned_')) throw new Error('未知的计划变更分类');
    await fillResolution(id, decision);
  }

  async function fillResolution(id, decision) {
    const { catalog, reason } = getClosureConfig().resolveFor(decision);
    const { action: resolveAction, openedBy } = await openResolveMenu(page);
    await log('resolve_menu_opened', { id, openedBy });
    // Arm before clicking: the toast is transient and may disappear while the
    // form is still being rendered. MutationObserver latches this action's event.
    const completion = await armAiCompletion(page);
    const startedAt = Date.now();
    try {
      await log('ai_fill_wait_started', { id, timeoutMs: 120000 });
      await resolveAction.click();
      await dialog().waitFor({ state: 'visible' });
      const signal = await completion.wait();
      await log('ai_fill_completed', { id, ...signal, elapsedMs: Date.now() - startedAt });
    } finally {
      await completion.dispose();
    }
    // Find the nearest field container with a combobox; generated rc_select IDs
    // change between forms, so they are deliberately not used.
    const techLabel = dialog().locator('label').filter({ hasText: 'Tech Catalog' });
    await techLabel.waitFor({ state: 'visible' });
    const techContainer = techLabel
      .locator('xpath=ancestor::*[descendant::*[@role="combobox"]][1]');
    if (await techContainer.getByRole('combobox').count() !== 1) {
      const structure = await techLabel.evaluate(el => {
        const result = [];
        for (let node = el, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
          result.push({ tag: node.tagName, id: node.id, class: node.className,
            comboboxes: [...node.querySelectorAll('[role="combobox"]')].map(box =>
              ({ tag: box.tagName, id: box.id, role: box.getAttribute('role') })) });
        }
        return result;
      });
      await log('tech_field_structure', { structure });
      throw new Error('技术分类字段结构发生变化');
    }
    const techInput = techContainer.getByRole('combobox');
    const enabledDeadline = Date.now() + 45000;
    while (!(await techInput.isEnabled())) {
      if (Date.now() >= enabledDeadline) throw new Error('等待平台表单填充完成超时');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // This cascader's search input is covered by its selected-value span.
    // Click the visible value/placeholder, as in the verified DOM workflow.
    await techContainer.locator('.ant-select-selection-item, .ant-select-selection-placeholder')
      .click({ timeout: 30000 });
    await log('manual_fields_started', { id });
    for (const name of catalog) await page.getByRole('menu').getByText(name, { exact: true }).click();
    const reasonContainer = dialog().locator('label').filter({ hasText: 'Reason of Alert' })
      .locator('xpath=ancestor::*[descendant::*[@role="combobox"]][1]');
    await reasonContainer.getByRole('combobox').click();
    for (const name of reason) await page.getByRole('menu').getByText(name, { exact: true }).click();
    await verifyResolution(decision);
  }

  async function verifyResolution(decision) {
    const { catalog, reason } = getClosureConfig().resolveFor(decision);
    await dialog().getByText(catalog.join(' > '), { exact: true }).waitFor({ state: 'visible' });
    await dialog().getByText(reason.join(' > '), { exact: true }).waitFor({ state: 'visible' });
    if (!(await dialog().getByRole('button', { name: 'Confirm', exact: true }).isEnabled())) {
      throw new Error('Confirm 不可用');
    }
  }


  async function confirmResolution(id) {
    // One attempt only. The caller records submit_attempt before entering here.
    await dialog().getByRole('button', { name: 'Confirm', exact: true }).click();
    await dialog().waitFor({ state: 'hidden', timeout: 30000 });
    const ticketRegion = panel().locator('xpath=ancestor::*[descendant::*[contains(concat(" ", normalize-space(@class), " "), " button_group ")]][1]');
    await ticketRegion.getByText(/^(Resolved|Closed)$/).waitFor({ state: 'visible', timeout: 30000 });
    return readResolutionResult(id);
  }

  async function capture(id, suffix) {
    if (!artifactDir) return null;
    const file = path.join(artifactDir, `${id}-${suffix}.jpg`);
    await page.screenshot({ path: file });
    return file;
  }

  return { log, enterAlarm, snapshotQueue, openTicket, readTicket, readResolutionResult, dismissTicket,
    fillResolution, fillPlannedResolution, verifyResolution, confirmResolution, capture };
}

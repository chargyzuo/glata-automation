// Wait for the relevant rendered content, independent of background polling.
// A quiet DOM alone is insufficient: required content and loading indicators
// must also pass. This does not replace the Resolve AI completion signal.
export async function waitForDomReady(scope, {
  mode = 'details', requiredFields = [], nonEmptyFields = [],
  timeoutMs = 30000, stableMs = 800,
} = {}) {
  await scope.waitFor({ state: 'visible', timeout: timeoutMs });
  return scope.evaluate(async (root, options) => {
    const { mode, requiredFields, nonEmptyFields, timeoutMs, stableMs } = options;
    const clean = value => (value ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ').trim();
    const visible = el => Boolean(el.getClientRects().length) &&
      getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const busySelector = '[aria-busy="true"], [role="progressbar"], .ant-spin-spinning, .arco-spin-loading, .ant-skeleton, .arco-skeleton';
    const started = Date.now();
    let previous = null, stableSince = 0, reason = '内容尚未出现';
    while (Date.now() - started < timeoutMs) {
      if (!root.isConnected) throw new Error('等待期间页面区域被替换，请重新运行');
      const nodes = [...root.querySelectorAll('*')];
      const exact = name => nodes.filter(el => clean(el.textContent) === name &&
        ![...el.children].some(child => clean(child.textContent) === name));
      const busy = [...root.querySelectorAll(busySelector)].some(visible) ||
        Boolean(root.closest('[aria-busy="true"], .ant-spin-spinning, .arco-spin-loading'));
      let contentReady = !busy;
      let schemaError = null;
      let empty = false;
      reason = busy ? '加载指示器仍可见' : '必需字段尚未就绪';
      if (mode === 'list') {
        const headers = [...root.querySelectorAll('th, [role="columnheader"]')].map(el => clean(el.textContent));
        const totals = nodes.filter(el => /^Total:\s*[\d,]+$/.test(clean(el.textContent)) &&
          ![...el.children].some(child => /^Total:\s*[\d,]+$/.test(clean(child.textContent))));
        const cells = [...root.querySelectorAll('td, [role="cell"]')];
        const hasRows = cells.some(el => /^IT-\d+$/.test(clean(el.textContent)) && visible(el));
        const zeroTotal = totals.length === 1 && Number(clean(totals[0].textContent).replace(/[^\d]/g, '')) === 0;
        // Glata omits pagination and Total when it renders its empty table row.
        empty = !hasRows && exact('No data').some(el => visible(el) && (zeroTotal ||
          (totals.length === 0 && el.closest('.arco-table-no-data') && el.closest('tr.arco-table-empty-row'))));
        if (headers.length && (headers.filter(name => name === 'Ticket ID').length !== 1 ||
            headers.filter(name => name === 'Subject').length !== 1)) {
          schemaError = '无法唯一定位 Ticket ID / Subject 列';
        }
        contentReady &&= headers.length > 0 && ((hasRows && totals.length === 1) || empty);
      }
      for (const label of new Set([...requiredFields, ...nonEmptyFields])) {
        const matches = exact(label).filter(visible);
        contentReady &&= matches.length === 1;
        if (nonEmptyFields.includes(label)) {
          contentReady &&= matches.length === 1 && Boolean(clean(matches[0].nextElementSibling?.textContent));
        }
      }
      // Observe field additions/value changes too, including an optional planned event.
      const signature = clean(root.innerText);
      if (contentReady && signature === previous) {
        if (Date.now() - stableSince >= stableMs) {
          if (schemaError) throw new Error(schemaError);
          return mode === 'list' ? empty : undefined;
        }
      } else {
        stableSince = Date.now();
      }
      previous = contentReady ? signature : null;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`等待${mode === 'list' ? '列表' : '详情'}内容就绪超时 (${timeoutMs}ms): ${reason}`);
  }, { mode, requiredFields, nonEmptyFields, timeoutMs, stableMs });
}

import { collectAlarmList } from './alarm-list.mjs';
import { createGlataWorkflow } from './workflow.mjs';
import { DEFAULT_VIEW, getView } from './views.mjs';

// Returns one Subject string per ticket. Identical names on different tickets are preserved.
export async function extractAlarmSubjects(page, {
  includeIds = false, navigate = true, maxPages = 1000, viewName = DEFAULT_VIEW.name, log = async () => {},
} = {}) {
  const view = getView(viewName);
  if (navigate) {
    await page.goto(view.url);
    await page.getByRole('link', { name: 'Service Desk', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    await createGlataWorkflow(page, { log }).enterAlarm({ viewName });
  }
  const records = await collectAlarmList(page, { maxPages, viewName, log });
  return includeIds ? records : records.map(record => record.subject);
}

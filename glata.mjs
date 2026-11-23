import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { manualPause } from './interactive.mjs';
import { parseArgs } from './rules.mjs';
import { createGlataWorkflow, START } from './workflow.mjs';
import { createTicketCloser, reportUnclassifiedPlanned } from './close-ticket.mjs';
import { extractAlarmSubjects } from './alarm-subjects.mjs';
import { DEFAULT_VIEW } from './views.mjs';
import { captureUnrecovered, withUnrecoveredGuard } from './unrecovered.mjs';
import { getClosureConfig } from './closure-config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2));
if (options.command === 'run' || options.command === 'close') {
  try { getClosureConfig(); }
  catch (error) { console.error(error.message); process.exit(1); }
}
const { chromium } = await import('playwright');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = path.join(ROOT, 'logs');
const artifactDir = path.join(ROOT, 'artifacts', runId);
await mkdir(logDir, { recursive: true });
await mkdir(artifactDir, { recursive: true });
const logFile = path.join(logDir, `${runId}.jsonl`);

async function log(event, data = {}) {
  const record = { time: new Date().toISOString(), event, ...data };
  await appendFile(logFile, `${JSON.stringify(record)}\n`);
  console.log(event, data);
}

const context = await chromium.launchPersistentContext(path.join(ROOT, '.browser-profile'), {
  headless: options.headless,
  viewport: { width: 1440, height: 1000 },
});
const page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(15000);
const workflow = createGlataWorkflow(page, { log, artifactDir });
let closeOne;
let activeId = null;
let submitted = 0;
const results = [];

async function handlePrepared(result) {
  if (result.outcome === 'prepared') {
    await manualPause('preview', '表单已填好，尚未点击 Confirm。请检查后结束预演。');
  }
}

try {
  if (options.command === 'subjects') {
    const tickets = await extractAlarmSubjects(page, { includeIds: true, log });
    const exportDir = path.join(ROOT, 'exports', runId);
    await mkdir(exportDir, { recursive: true });
    const jsonFile = path.join(exportDir, 'alarm-subjects.json');
    const textFile = path.join(exportDir, 'alarm-subjects.txt');
    await writeFile(jsonFile, `${JSON.stringify({ view: DEFAULT_VIEW.name, viewId: DEFAULT_VIEW.id,
      exportedAt: new Date().toISOString(), total: tickets.length, tickets }, null, 2)}\n`);
    await writeFile(textFile, tickets.length ? `${tickets.map(ticket => ticket.subject).join('\n')}\n` : '');
    await log('alarm_subjects_exported', { count: tickets.length, jsonFile, textFile });
  } else if (options.command === 'close') {
    // Exact-ticket branch: bypass list filters, but preserve all detail guards.
    activeId = options.ticket;
    const unrecovered = await captureUnrecovered(page, { log, artifactDir });
    closeOne = createTicketCloser(withUnrecoveredGuard(workflow, unrecovered));
    const result = await closeOne(activeId, { submit: options.submit, source: 'direct' });
    results.push(result);
    await log('single_ticket_result', result);
    await handlePrepared(result);
    submitted = result.outcome === 'resolved' ? 1 : 0;
    if (result.outcome === 'skipped') process.exitCode = 2;
  } else {
    await page.goto(START);
    if (options.command === 'login') {
      await manualPause('login', '请在打开的专用浏览器中完成登录，并确认能看到工单列表。');
      await page.getByRole('link', { name: 'Service Desk', exact: true }).waitFor({ state: 'visible' });
      await log('login_saved');
    } else {
      await page.getByRole('link', { name: 'Service Desk', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      const unrecovered = await captureUnrecovered(page, { log, artifactDir });
      closeOne = createTicketCloser(withUnrecoveredGuard(workflow, unrecovered));
      await workflow.enterAlarm();
      const ids = await workflow.snapshotQueue({ ticket: options.ticket, maxScan: options.maxScan });
      await log('queue_snapshot', { ids, order: 'last_to_first', submit: options.submit, max: options.max });
      for (const id of ids) {
        activeId = id;
        const result = await closeOne(id, { submit: options.submit, source: 'alarm' });
        results.push(result);
        if (result.outcome === 'prepared') { await handlePrepared(result); break; }
        if (result.outcome === 'resolved') submitted++;
        // The next saved ID navigates directly; no list search/refresh is needed.
        if (options.max !== null && submitted >= options.max) break;
      }
    }
  }
  await log('run_complete', { submitted, logFile });
} catch (error) {
  try { await page.screenshot({ path: path.join(artifactDir, 'error.jpg') }); } catch {}
  await log('stopped', { id: error.ticketId ?? activeId, phase: error.phase ?? 'startup',
    message: error.message, outcomeUnknown: error.outcomeUnknown ?? false });
  console.error('已停止。先检查日志和当前工单状态，再决定是否重跑。');
  process.exitCode = 1;
} finally {
  try { await reportUnclassifiedPlanned(results, log); }
  finally { await context.close(); }
}

import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canPause, manualPause } from './interactive.mjs';
import { createGlataWorkflow, START } from './workflow.mjs';
import { createTicketCloser, reportUnclassifiedPlanned } from './close-ticket.mjs';
import { parseConcurrentArgs, allocateTickets, bindAssignedWorkflow, runConcurrentBatches } from './concurrent.mjs';
import { captureUnrecovered, withUnrecoveredGuard } from './unrecovered.mjs';
import { getClosureConfig } from './closure-config.mjs';

const argv = process.argv.slice(2);
if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
  console.log('预演：npm run concurrent -- --workers 3\n提交全部符合条件工单：npm run concurrent -- --workers 3 --submit\n默认 workers=2，不限制处理数量；工单数少于 workers 自动改用单页串行，空队列不启动任务。\n--max 和 --max-scan 仅在明确传入时限制数量。');
} else {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  const options = parseConcurrentArgs(argv);
  getClosureConfig();
  if (!options.submit && !canPause()) throw new Error('预演需要交互式终端，以便保留页面供检查。');
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-concurrent`;
  const artifactDir = path.join(ROOT, 'artifacts', runId);
  const logDir = path.join(ROOT, 'logs');
  await mkdir(artifactDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${runId}.jsonl`);
  let logChain = Promise.resolve();
  async function log(event, data = {}) {
    const record = { time: new Date().toISOString(), event, ...data };
    const write = logChain.then(() => appendFile(logFile, `${JSON.stringify(record)}\n`));
    logChain = write.catch(() => {});
    await write;
    console.log(event, data);
  }
  let context, listPage;
  const pages = new Map();
  try {
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(path.join(ROOT, '.browser-profile'), {
      headless: options.headless, viewport: { width: 1440, height: 1000 },
    });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
    listPage = context.pages()[0] ?? await context.newPage();
    await listPage.goto(START);
    await listPage.getByRole('link', { name: 'Service Desk', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    const workflow = createGlataWorkflow(listPage, { log, artifactDir });
    const unrecovered = await captureUnrecovered(listPage, { log, artifactDir });
    await workflow.enterAlarm();
    const ids = await workflow.snapshotQueue({ maxScan: options.maxScan });
    const allocation = allocateTickets(ids, options.workers);
    if (allocation.mode === 'serial' && allocation.requestedWorkers > 1) {
      await log('serial_fallback', { reason: 'tickets_less_than_workers', total: allocation.total,
        requestedWorkers: allocation.requestedWorkers, workers: 1 });
    }
    const allocationFile = path.join(artifactDir, 'worker-assignments.json');
    await writeFile(allocationFile, `${JSON.stringify(allocation, null, 2)}\n`);
    await log('workers_allocated', { requestedWorkers: allocation.requestedWorkers, workers: allocation.workers,
      mode: allocation.mode, total: allocation.total,
      base: allocation.base, remainder: allocation.remainder, extraWorker: allocation.extraWorker,
      counts: allocation.assignments.map(group => ({ worker: group.worker, count: group.ids.length })),
      submit: options.submit, max: options.max, allocationFile });
    await listPage.close();
    listPage = null;
    const result = await runConcurrentBatches(allocation.assignments, {
      submit: options.submit, max: options.max, log,
      async createWorker(group, isStopped) {
        const page = await context.newPage();
        pages.set(group.worker, page);
        const workerDir = path.join(artifactDir, `worker-${group.worker}`);
        await mkdir(workerDir, { recursive: true });
        const workerLog = (event, data = {}) => log(event, { ...data, worker: group.worker });
        const ownWorkflow = createGlataWorkflow(page, { log: workerLog, artifactDir: workerDir });
        const assigned = bindAssignedWorkflow(ownWorkflow, group.ids, isStopped);
        return { closeTicket: createTicketCloser(withUnrecoveredGuard(assigned, unrecovered)) };
      },
      async onError(group) {
        const page = pages.get(group.worker);
        if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifactDir, `worker-${group.worker}-error.jpg`) });
      },
    });
    if (result.errors.length) {
      process.exitCode = 1;
      console.error('并发任务已停止；已等待进行中的任务结束。请先核对日志中的工单结果，再决定是否重跑。');
    } else if (result.prepared) {
      await manualPause('preview', `${result.prepared} 个页面已填写，均未点击 Confirm。结束预演后关闭浏览器。`);
    }
    await reportUnclassifiedPlanned(result.results, log);
    await log('concurrent_run_complete', { mode: allocation.mode, submitted: result.submitted, prepared: result.prepared,
      errors: result.errors.length, logFile });
  } catch (error) {
    try { if (listPage && !listPage.isClosed()) await listPage.screenshot({ path: path.join(artifactDir, 'startup-error.jpg') }); } catch {}
    await log('stopped', { phase: 'startup', message: error.message, outcomeUnknown: false });
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
  }
}

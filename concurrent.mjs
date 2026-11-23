import { randomInt } from 'node:crypto';
import { normalizeTicketId } from './rules.mjs';

export function parseConcurrentArgs(argv) {
  const options = { workers: 2, submit: false, headless: false, max: null, maxScan: null };
  const seen = new Set();
  const numbers = { '--workers': 'workers', '--max': 'max', '--max-scan': 'maxScan' };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
    seen.add(flag);
    if (flag === '--submit') options.submit = true;
    else if (flag === '--dry-run') options.submit = false;
    else if (flag === '--headless') options.headless = true;
    else if (Object.hasOwn(numbers, flag)) {
      const raw = argv[++index];
      if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
        throw new Error(`${flag} 必须为正整数`);
      }
      options[numbers[flag]] = Number(raw);
    } else throw new Error(`未知参数: ${flag}`);
  }
  if (seen.has('--submit') && seen.has('--dry-run')) throw new Error('--submit 与 --dry-run 不能同时使用');
  if (options.headless && !options.submit) throw new Error('--headless 仅用于已登录的 --submit 模式');
  return options;
}

// Keep the reversed snapshot order within each contiguous assignment.
// All remainder tickets belong to ONE uniformly random worker, as requested.
export function allocateTickets(ticketIds, workers, chooseWorker = randomInt) {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error('workers 必须为正整数');
  const ids = ticketIds.map(normalizeTicketId);
  if (new Set(ids).size !== ids.length) throw new Error('队列包含重复工单');
  const requestedWorkers = workers;
  if (!ids.length) return { requestedWorkers, workers: 0, mode: 'empty', total: 0,
    base: 0, remainder: 0, extraWorker: null, assignments: [] };
  // A short queue uses one page in order, without random remainder allocation.
  if (ids.length < workers) workers = 1;
  const base = Math.floor(ids.length / workers);
  const remainder = ids.length % workers;
  const extraIndex = remainder ? chooseWorker(workers) : null;
  if (extraIndex !== null && (!Number.isSafeInteger(extraIndex) || extraIndex < 0 || extraIndex >= workers)) {
    throw new Error('随机分配结果越界');
  }
  let offset = 0;
  const assignments = Array.from({ length: workers }, (_, index) => {
    const count = base + (index === extraIndex ? remainder : 0);
    const group = { worker: index + 1, ids: ids.slice(offset, offset + count) };
    offset += count;
    return group;
  });
  return { requestedWorkers, workers, mode: workers === 1 ? 'serial' : 'concurrent', total: ids.length, base, remainder,
    extraWorker: extraIndex === null ? null : extraIndex + 1, assignments };
}

// Adapt a new page to an already captured, disjoint assignment. The shared
// serial workflow is unchanged. The closer still receives source:'alarm',
// so direct URL navigation does not enable the single-ticket Alert Status rule.
export function bindAssignedWorkflow(workflow, ticketIds, isStopped = () => false) {
  const allowed = new Set(ticketIds.map(normalizeTicketId));
  const check = () => {
    if (isStopped()) throw new Error('其它并发任务已停止，取消后续填写或提交');
  };
  const assigned = {
    ...workflow,
    async openTicket(id, { source } = {}) {
      check();
      if (source !== 'alarm') throw new Error('并发入口只处理本轮 Alarm_recovered 分配队列');
      if (!allowed.has(id)) return false;
      return workflow.openTicket(id, { source: 'direct' });
    },
  };
  for (const method of ['readTicket', 'fillResolution', 'fillPlannedResolution', 'verifyResolution', 'confirmResolution']) {
    assigned[method] = async (...args) => { check(); return workflow[method](...args); };
  }
  return assigned;
}

// Reserve a possible success BEFORE starting a ticket. A skip releases its
// reservation. This guarantees submitted <= max even with simultaneous pages.
function submissionBudget(max) {
  let submitted = 0, active = 0, stopped = false;
  const waiters = new Set();
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  return {
    get submitted() { return submitted; },
    get active() { return active; },
    isStopped: () => stopped,
    stop() { stopped = true; wake(); },
    async acquire() {
      while (!stopped && submitted < max) {
        if (submitted + active < max) {
          active++;
          let finished = false;
          return result => {
            if (finished) throw new Error('并发名额重复释放');
            finished = true;
            active--;
            if (result?.outcome === 'resolved') submitted++;
            wake();
          };
        }
        await new Promise(resolve => waiters.add(resolve));
      }
      return null;
    },
  };
}

export async function runConcurrentBatches(assignments, {
  submit = false, max = null, createWorker, log = async () => {}, onError = async () => {},
} = {}) {
  if (typeof submit !== 'boolean' || (max !== null && (!Number.isSafeInteger(max) || max < 1))) throw new Error('并发运行参数错误');
  const allIds = assignments.flatMap(group => group.ids);
  const workerIds = assignments.map(group => group.worker);
  if (new Set(allIds).size !== allIds.length || new Set(workerIds).size !== workerIds.length) {
    throw new Error('并发任务编号或工单分配重复');
  }
  const budget = submissionBudget(submit && max !== null ? max : Infinity);
  const results = [], errors = [];
  // Every task catches its error. Await ALL in-flight tasks before browser close,
  // including any Confirm already sent when another page failed.
  await Promise.all(assignments.filter(group => group.ids.length).map(async group => {
    let activeId = null, phase = 'worker_startup', finish = null;
    try {
      const worker = await createWorker(group, budget.isStopped);
      for (const id of group.ids) {
        finish = await budget.acquire();
        if (!finish) break;
        activeId = id;
        phase = 'ticket';
        const startedAt = Date.now();
        await log('worker_ticket_started', { worker: group.worker, id, inFlight: budget.active });
        const result = await worker.closeTicket(id, { submit, source: 'alarm' });
        results.push({ worker: group.worker, ...result });
        finish(result);
        finish = null;
        await log('worker_ticket_result', { worker: group.worker, ...result, elapsedMs: Date.now() - startedAt, inFlight: budget.active });
        if (result.outcome === 'prepared') break; // Keep one preview per page.
      }
      await log('worker_complete', { worker: group.worker });
    } catch (error) {
      budget.stop();
      if (finish) { finish(); finish = null; }
      const failure = { worker: group.worker, id: error.ticketId ?? activeId,
        phase: error.phase ?? phase, message: error.message, outcomeUnknown: error.outcomeUnknown ?? false };
      errors.push(failure);
      try { await log('worker_stopped', failure); } catch { /* retain original failure */ }
      try { await onError(group, failure); } catch { /* best-effort screenshot */ }
    }
  }));
  return { submitted: budget.submitted, prepared: results.filter(result => result.outcome === 'prepared').length,
    results, errors };
}

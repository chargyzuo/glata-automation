import { normalize, normalizeTicketId, decide, meaningful, resolvedSuccessfully } from './rules.mjs';
import { createGlataWorkflow } from './workflow.mjs';
import { isAlertRecovered } from './archive/alert-status.mjs';
import { captureUnrecovered, withUnrecoveredGuard } from './unrecovered.mjs';
import { getClosureConfig } from './closure-config.mjs';

const matchFields = {
  subject: 'Subject',
  description: 'Description',
  planned: 'Monisight AI Planned Event Analysis',
};

function decideForSource(ticket, source) {
  const decision = decide(ticket);
  if (['skip_finished', 'skip_status'].includes(decision)) return decision;
  if (source === 'direct' && !isAlertRecovered(ticket.alertStatus)) return 'skip_not_recovered';
  return decision;
}

export class TicketClosureError extends Error {
  constructor(id, phase, cause) {
    super(`${id}: ${cause.message}`, { cause });
    this.name = 'TicketClosureError';
    this.ticketId = id;
    this.phase = phase;
    this.outcomeUnknown = phase === 'submit_attempt';
  }
}

export async function reportUnclassifiedPlanned(results, log) {
  const skipped = results.filter(result =>
    ['skip_planned_unclassified', 'skip_planned_ambiguous'].includes(result.reason))
    .map(({ id, reason }) => ({ id, reason }));
  if (skipped.length) await log('planned_change_skips', { count: skipped.length, tickets: skipped });
}

// Shared orchestration: both single-ticket and batch entry points use this function.
export function createTicketCloser(workflow) {
  return async function closeTicket(ticketId, { submit = false, source = 'direct' } = {}) {
    const id = normalizeTicketId(ticketId);
    if (typeof submit !== 'boolean') throw new Error('submit 必须为布尔值');
    if (!['direct', 'alarm'].includes(source)) throw new Error('未知工单打开方式');
    let phase = 'open';
    try {
      if (await workflow.isUnrecovered?.(id)) {
        await workflow.log('skip_unrecovered_snapshot', { id });
        return { id, outcome: 'skipped', reason: 'skip_unrecovered_snapshot', opened: false };
      }
      if (!(await workflow.openTicket(id, { source }))) {
        await workflow.log('skip_not_in_snapshot', { id });
        return { id, outcome: 'skipped', reason: 'skip_not_in_snapshot', opened: false };
      }
      phase = 'inspect';
      const readOptions = { includeAlertStatus: source === 'direct' };
      const ticket = await workflow.readTicket(id, readOptions);
      if (ticket.id !== id) throw new Error('读取到的工单编号与请求不一致');
      const decision = decideForSource(ticket, source);
      const fields = getClosureConfig().fieldsFor(decision);
      const matchField = decision.startsWith('skip_planned_')
        ? matchFields.planned
        : fields.map(field => matchFields[field]).join(' + ') || null;
      await workflow.log('decision', { id, decision, status: ticket.status,
        matchField,
        ...(source === 'direct' ? { alertStatus: ticket.alertStatus } : {}),
        plannedFieldPresent: ticket.planned?.present, plannedHasContent: meaningful(ticket.planned?.value) });
      if (decision.startsWith('review_')) throw new Error(`需要检查: ${decision}`);
      const plannedChange = decision.startsWith('eligible_planned_');
      const ordinaryBranch = decision.startsWith('eligible_ordinary_');
      if (decision !== 'eligible' && !plannedChange && !ordinaryBranch) {
        return { id, outcome: decision === 'skip_finished' ? 'already_finished' : 'skipped',
          reason: decision, status: ticket.status, opened: true };
      }
      phase = 'fill';
      // Includes the mandatory wait for this Resolve action's AI completion toast.
      if (plannedChange) await workflow.fillPlannedResolution(id, decision);
      else await workflow.fillResolution(id, decision);
      if (!submit) {
        const screenshot = await workflow.capture(id, 'prepared');
        await workflow.log('prepared_not_submitted', { id });
        return { id, outcome: 'prepared', opened: true, screenshot };
      }
      phase = 'recheck';
      if (await workflow.isUnrecovered?.(id)) throw new Error('工单命中未恢复列表，已阻止提交');
      const fresh = await workflow.readTicket(id, readOptions);
      if (fresh.id !== id || decideForSource(fresh, source) !== decision ||
          (plannedChange && normalize(fresh.planned.value) !== normalize(ticket.planned.value))) {
        throw new Error('提交前工单或条件发生变化，已停止');
      }
      await workflow.verifyResolution(decision);
      phase = 'submit_attempt';
      await workflow.log('submit_attempt', { id });
      const result = await workflow.confirmResolution(id);
      if (result.id !== id || !resolvedSuccessfully(result, result.resolvedDate)) {
        throw new Error('提交后未确认 Resolved / Closed；禁止自动重复提交');
      }
      phase = 'resolved';
      await workflow.log('resolved', { id, status: result.status, resolvedDate: result.resolvedDate });
      const screenshot = await workflow.capture(id, 'resolved');
      return { id, outcome: 'resolved', status: result.status, resolvedDate: result.resolvedDate,
        opened: true, screenshot };
    } catch (cause) {
      throw new TicketClosureError(id, phase, cause);
    }
  };
}

// Importable public API. The caller owns the logged-in Playwright page/context.
// Resolving (platform's Resolve action) does not promise immediate Closed status.
export async function closeTicket(page, ticketId, {
  submit = false, source = 'direct', log = async () => {}, artifactDir = null,
} = {}) {
  const snapshot = await captureUnrecovered(page, { log, artifactDir });
  const workflow = withUnrecoveredGuard(createGlataWorkflow(page, { log, artifactDir }), snapshot);
  return createTicketCloser(workflow)(ticketId, { submit, source });
}

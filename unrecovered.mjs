import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { extractAlarmSubjects } from './alarm-subjects.mjs';
import { normalizeTicketId } from './rules.mjs';
import { VIEWS } from './views.mjs';

// Read the ENTIRE exclusion view first. A failed/incomplete read must throw;
// it must never be converted into an empty exclusion list.
export async function captureUnrecovered(page, { log = async () => {}, artifactDir = null } = {}) {
  const view = VIEWS.Alarm_unrecovered;
  const tickets = await extractAlarmSubjects(page, { includeIds: true, viewName: view.name, log });
  const snapshot = { view: view.name, viewId: view.id, capturedAt: new Date().toISOString(),
    total: tickets.length, ids: tickets.map(ticket => ticket.id), tickets };
  const file = artifactDir ? path.join(artifactDir, 'unrecovered-snapshot.json') : null;
  if (file) await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  await log('unrecovered_snapshot_saved', { total: snapshot.total, file, capturedAt: snapshot.capturedAt });
  return snapshot;
}

export function withUnrecoveredGuard(workflow, snapshot) {
  if (!snapshot || snapshot.view !== VIEWS.Alarm_unrecovered.name ||
      snapshot.viewId !== VIEWS.Alarm_unrecovered.id || !Array.isArray(snapshot.ids) ||
      snapshot.total !== snapshot.ids.length) throw new Error('未恢复工单快照缺失或不完整，禁止关单');
  const ids = snapshot.ids.map(normalizeTicketId);
  if (new Set(ids).size !== ids.length) throw new Error('未恢复工单快照包含重复编号，禁止关单');
  const blocked = new Set(ids);
  return { ...workflow, isUnrecovered: id => blocked.has(normalizeTicketId(id)) };
}

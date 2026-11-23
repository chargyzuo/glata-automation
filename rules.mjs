import { getClosureConfig } from './closure-config.mjs';

export function normalize(value) {
  return String(value ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00a0/g, ' ').trim();
}

export function meaningful(value) {
  const text = normalize(value);
  return text !== '' && !/^[-—–]+$/.test(text);
}

export function resolvedSuccessfully(ticket, resolvedDate) {
  return ['Resolved', 'Closed'].includes(normalize(ticket.status)) && meaningful(resolvedDate);
}

export function reverseQueue(ids, limit) {
  // Reverse the complete list before applying the scan limit, so a short limit
  // still starts at the actual end of the last page.
  return [...new Set(ids)].reverse().slice(0, limit ?? undefined);
}

export function normalizeTicketId(value) {
  const match = String(value ?? '').trim().match(/^(?:IT-)?([1-9]\d*)$/i);
  if (!match) throw new Error('工单编号格式错误');
  return `IT-${match[1]}`;
}

export function matchesSubject(subject) {
  return getClosureConfig().matchesSubject(normalize(subject));
}

export function decide(ticket, config = getClosureConfig()) {
  if (/^(Resolved|Closed)$/i.test(normalize(ticket.status))) return 'skip_finished';
  if (normalize(ticket.status) !== 'In progress') return 'skip_status';
  const analysis = normalize(ticket.planned?.value);
  if (ticket.planned?.present && config.matchesPlannedEvent(analysis)) {
    const matches = config.plannedBranches.filter(branch => branch.matches(analysis));
    if (matches.length > 1) return 'skip_planned_ambiguous';
    return matches[0]?.decision ?? 'skip_planned_unclassified';
  }
  if (!meaningful(ticket.subject)) return 'review_missing_subject';
  const ordinaryDecision = config.ordinaryDecision(normalize(ticket.subject));
  if (!ordinaryDecision) return 'skip_subject';
  if (ticket.planned === undefined) return 'review_unreadable_planned_field';
  if (ticket.planned.present && meaningful(ticket.planned.value)) return 'skip_planned_event';
  return ordinaryDecision;
}

export function parseArgs(argv) {
  const command = argv[0] ?? 'run';
  if (!['login', 'run', 'close', 'subjects'].includes(command)) throw new Error('命令应为 login、run、close 或 subjects');
  const options = { command, submit: command === 'close', headless: false, max: null, maxScan: null, ticket: null };
  const start = command === 'close' ? 2 : 1;
  if (command === 'close') options.ticket = normalizeTicketId(argv[1]);
  const seen = new Set();
  for (let i = start; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
    seen.add(flag);
    if (flag === '--submit') options.submit = true;
    else if (flag === '--dry-run') options.submit = false;
    else if (flag === '--headless') options.headless = true;
    else if (['--max', '--max-scan', '--ticket'].includes(flag)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} 缺少值`);
      if (flag === '--ticket') {
        options.ticket = normalizeTicketId(value);
      } else {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} 必须为正整数`);
        options[flag === '--max' ? 'max' : 'maxScan'] = number;
      }
    } else throw new Error(`未知参数: ${flag}`);
  }
  if (seen.has('--submit') && seen.has('--dry-run')) throw new Error('--submit 与 --dry-run 不能同时使用');
  if (command === 'close' && ['--ticket', '--max', '--max-scan'].some(flag => seen.has(flag))) {
    throw new Error('close 仅处理一个位置参数工单号，不接受 --ticket、--max 或 --max-scan');
  }
  if (command === 'subjects' && [...seen].some(flag => flag !== '--headless')) {
    throw new Error('subjects 是只读命令，仅接受 --headless');
  }
  if (options.headless && command !== 'subjects' && (!options.submit || command === 'login')) {
    throw new Error('--headless 仅用于已经登录的 --submit 模式');
  }
  if (command === 'login' && (options.submit || options.ticket || seen.has('--max') || seen.has('--max-scan') || seen.has('--dry-run'))) {
    throw new Error('login 不接受工单处理参数');
  }
  return options;
}

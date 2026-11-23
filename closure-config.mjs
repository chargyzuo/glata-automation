import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

const configFile = new URL('closure-rules.yaml', import.meta.url);

function record(value, required, optional, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at} 必须为映射`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${at} 缺少 ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Error(`${at} 含未知字段 ${key}`);
  }
  return value;
}

function textList(value, at) {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${at} 必须为非空文本列表`);
  }
  return Object.freeze(value.map(item => item.trim()));
}

function matcher(value, at) {
  const condition = record(value, [], ['regex', 'contains_any', 'ignore_case'], at);
  const regex = Object.hasOwn(condition, 'regex');
  if (regex === Object.hasOwn(condition, 'contains_any')) {
    throw new Error(`${at} 必须且只能设置 regex 或 contains_any 其中一项`);
  }
  if (Object.hasOwn(condition, 'ignore_case') && typeof condition.ignore_case !== 'boolean') {
    throw new Error(`${at}.ignore_case 必须为布尔值`);
  }
  if (regex) {
    if (typeof condition.regex !== 'string' || !condition.regex.trim()) throw new Error(`${at}.regex 必须为非空文本`);
    let pattern;
    try { pattern = new RegExp(condition.regex, condition.ignore_case ? 'i' : ''); }
    catch (cause) { throw new Error(`${at}.regex 无效`, { cause }); }
    if (pattern.test('')) throw new Error(`${at}.regex 不可匹配空文本`);
    return text => pattern.test(text);
  }
  const fold = condition.ignore_case ? text => text.toLowerCase() : text => text;
  const terms = textList(condition.contains_any, `${at}.contains_any`).map(fold);
  return text => terms.some(term => fold(text).includes(term));
}

function resolution(value, at) {
  const action = record(value, ['tech_catalog', 'reason_of_alert'], [], at);
  return Object.freeze({
    catalog: textList(action.tech_catalog, `${at}.tech_catalog`),
    reason: textList(action.reason_of_alert, `${at}.reason_of_alert`),
  });
}

export function parseClosureConfig(source) {
  const document = parseDocument(source);
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  const root = record(document.toJS({ maxAliasCount: 0 }), ['version', 'ordinary', 'planned'], [], '配置');
  if (root.version !== 1) throw new Error('version 必须为 1');
  const ordinary = record(root.ordinary, ['subject', 'resolve'], [], 'ordinary');
  const planned = record(root.planned, ['detect', 'branches'], [], 'planned');
  if (!Array.isArray(planned.branches)) throw new Error('planned.branches 必须为列表');
  const decisions = new Set();
  const branches = planned.branches.map((value, index) => {
    const at = `planned.branches[${index}]`;
    const branch = record(value, ['id', 'when', 'resolve'], [], at);
    if (typeof branch.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(branch.id)) {
      throw new Error(`${at}.id 必须以小写英文字母开头，且只含小写字母、数字和下划线`);
    }
    const decision = 'eligible_planned_' + branch.id;
    if (decisions.has(decision)) throw new Error(`${at}.id 重复`);
    decisions.add(decision);
    return Object.freeze({ decision, matches: matcher(branch.when, at + '.when'),
      resolve: resolution(branch.resolve, at + '.resolve') });
  });
  const ordinaryResolution = resolution(ordinary.resolve, 'ordinary.resolve');
  return Object.freeze({
    matchesSubject: matcher(ordinary.subject, 'ordinary.subject'),
    matchesPlannedEvent: matcher(planned.detect, 'planned.detect'),
    plannedBranches: Object.freeze(branches),
    resolveFor(decision) {
      if (decision === 'eligible') return ordinaryResolution;
      const branch = branches.find(item => item.decision === decision);
      if (!branch) throw new Error(`没有为 ${decision} 配置 Resolve 操作`);
      return branch.resolve;
    },
  });
}

let config;
// One validated snapshot per process, including the checks before Confirm.
export function getClosureConfig() {
  if (!config) {
    try { config = parseClosureConfig(readFileSync(configFile, 'utf8')); }
    catch (cause) { throw new Error(`closure-rules.yaml 无效：${cause.message}`, { cause }); }
  }
  return config;
}

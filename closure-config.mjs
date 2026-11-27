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

function matcher(value, at, extraKeys = []) {
  const condition = record(value, [], ['regex', 'contains_any', 'ignore_case', ...extraKeys], at);
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

function ordinaryCondition(value, at) {
  const combined = Object.hasOwn(value ?? {}, 'all');
  const conditions = combined ? record(value, ['all'], [], at).all : [value];
  if (!Array.isArray(conditions) || !conditions.length) throw new Error(`${at}.all 必须为非空列表`);

  const checks = conditions.map((condition, index) => {
    const path = combined ? `${at}.all[${index}]` : at;
    const matches = matcher(condition, path, ['field']);
    const field = Object.hasOwn(condition, 'field') ? condition.field : 'subject';
    if (!['subject', 'description'].includes(field)) {
      throw new Error(`${path}.field 必须为 subject 或 description`);
    }
    return { field, matches };
  });
  return {
    fields: Object.freeze([...new Set(checks.map(check => check.field))]),
    matches: fields => checks.every(check => fields[check.field] && check.matches(fields[check.field])),
  };
}

function parseBranches(values, group) {
  if (!Array.isArray(values)) throw new Error(`${group}.branches 必须为列表`);
  const decisions = new Set();
  return Object.freeze(values.map((value, index) => {
    const at = `${group}.branches[${index}]`;
    const branch = record(value, ['id', 'when', 'resolve'], [], at);
    if (typeof branch.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(branch.id)) {
      throw new Error(`${at}.id 必须以小写英文字母开头，且只含小写字母、数字和下划线`);
    }
    const decision = `eligible_${group}_${branch.id}`;
    if (decisions.has(decision)) throw new Error(`${at}.id 重复`);
    decisions.add(decision);
    const condition = group === 'ordinary'
      ? ordinaryCondition(branch.when, at + '.when')
      : { fields: Object.freeze(['planned']), matches: matcher(branch.when, at + '.when') };
    return Object.freeze({ decision, ...condition,
      resolve: resolution(branch.resolve, at + '.resolve') });
  }));
}

export function parseClosureConfig(source) {
  const document = parseDocument(source);
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw issue;
  const root = record(document.toJS({ maxAliasCount: 0 }), ['version', 'ordinary', 'planned'], [], '配置');
  if (root.version !== 1) throw new Error('version 必须为 1');
  const ordinary = record(root.ordinary, [], ['branches', 'subject', 'resolve'], 'ordinary');
  const planned = record(root.planned, ['detect', 'branches'], [], 'planned');
  const branches = parseBranches(planned.branches, 'planned');
  const hasBranches = Object.hasOwn(ordinary, 'branches');
  const hasSubject = Object.hasOwn(ordinary, 'subject');
  const hasResolve = Object.hasOwn(ordinary, 'resolve');
  if (hasSubject !== hasResolve || (!hasBranches && !hasSubject)) {
    throw new Error('ordinary 需要 branches，或同时提供旧格式的 subject 与 resolve');
  }
  const ordinaryBranches = hasBranches ? parseBranches(ordinary.branches, 'ordinary') : [];
  // Legacy configurations place the ordinary fallback outside the branch list.
  const legacyMatch = hasSubject ? matcher(ordinary.subject, 'ordinary.subject') : null;
  const legacyBranch = hasSubject ? {
    decision: 'eligible',
    fields: Object.freeze(['subject']),
    matches: ({ subject }) => Boolean(subject) && legacyMatch(subject),
    resolve: resolution(ordinary.resolve, 'ordinary.resolve'),
  } : null;
  const ordinaryRules = legacyBranch ? [...ordinaryBranches, legacyBranch] : ordinaryBranches;
  const allRules = [...ordinaryRules, ...branches];
  function ordinaryDecision(subject, description = '') {
    const fields = { subject, description };
    return ordinaryRules.find(rule => rule.matches(fields))?.decision ?? null;
  }
  return Object.freeze({
    matchesSubject: text => ordinaryDecision(text) !== null,
    ordinaryDecision,
    matchesPlannedEvent: matcher(planned.detect, 'planned.detect'),
    plannedBranches: Object.freeze(branches),
    fieldsFor(decision) {
      return allRules.find(rule => rule.decision === decision)?.fields ?? [];
    },
    resolveFor(decision) {
      const branch = allRules.find(item => item.decision === decision);
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

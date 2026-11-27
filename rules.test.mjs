import test from 'node:test';
import assert from 'node:assert/strict';
import { getClosureConfig, parseClosureConfig } from './closure-config.mjs';
import { decide, matchesSubject, parseArgs, meaningful, normalize, resolvedSuccessfully, reverseQueue } from './rules.mjs';

const eligible = {
  status: 'In progress',
  subject: '[Baseline-Net]-SDWAN-Fortinet Link-Monitor Down CNXIY17-F05-M-F121G-SPOKE01',
  planned: { present: false, value: '' },
};

const customRules = `
version: 1
ordinary:
  subject: { regex: '^DNSS', ignore_case: true }
  resolve:
    tech_catalog: [Network, WAN&Internet, internet]
    reason_of_alert: [Network Alert, Network Issues]
planned:
  detect: { contains_any: [相关计划事件] }
  branches:
    - id: custom
      when: { contains_any: [测试分类] }
      resolve:
        tech_catalog: [Infrastructure, Server room equipment, UPS]
        reason_of_alert: [Network Alert, Planned Events/Changes were not suppressed]
`;

test('YAML 可修改标题条件并为新变更分支提供表单选项', () => {
  const config = parseClosureConfig(customRules);
  assert.equal(decide(eligible, config), 'skip_subject');
  assert.equal(decide({ ...eligible, subject: 'dnss packet loss' }, config), 'eligible');
  const ticket = { ...eligible, planned: { present: true, value: '相关计划事件，测试分类' } };
  const decision = decide(ticket, config);
  assert.equal(decision, 'eligible_planned_custom');
  assert.deepEqual(config.resolveFor(decision), {
    catalog: ['Infrastructure', 'Server room equipment', 'UPS'],
    reason: ['Network Alert', 'Planned Events/Changes were not suppressed'],
  });
  assert.throws(() => config.resolveFor('eligible_planned_unknown'), /没有为/);
});

test('YAML 校验拒绝重复键、无效正则和空表单路径', () => {
  assert.throws(() => parseClosureConfig(customRules + '\nversion: 1\n'), /unique/i);
  assert.throws(() => parseClosureConfig(customRules.replace('^DNSS', '[')), /regex 无效/);
  assert.throws(() => parseClosureConfig(customRules.replace('[Network Alert, Network Issues]', '[]')), /非空文本列表/);
  assert.deepEqual(getClosureConfig().resolveFor('eligible_planned_wan').catalog, ['Network', 'WAN&Internet', 'internet']);
  assert.deepEqual(getClosureConfig().resolveFor('eligible_planned_ups').catalog, ['Infrastructure', 'Server room equipment', 'UPS']);
  assert.deepEqual(getClosureConfig().resolveFor('eligible_ordinary_network'), {
    catalog: ['Network', 'WAN&Internet', 'internet'],
    reason: ['Network Alert', 'Network Issues'],
  });
});

const extraOrdinaryRules = customRules.replace('\nplanned:', `
  branches:
    - id: internet
      when: { contains_any: [INTERNET], ignore_case: true }
      resolve:
        tech_catalog: [Infrastructure, Server room equipment, UPS]
        reason_of_alert: [Network Alert, Network Issues]
    - id: internet_a
      when: { contains_any: [INTERNET-A] }
      resolve:
        tech_catalog: [Network, WAN&Internet, internet]
        reason_of_alert: [Network Alert, Network Issues]
planned:`);

test('新增普通分支按顺序选择独立动作，并支持原有单组配置', () => {
  const config = parseClosureConfig(extraOrdinaryRules.replace(
    /\n  subject:[\s\S]*?(?=\n  branches:)/, '',
  ));
  const ticket = { ...eligible, subject: 'internet-a_[Baseline-Net]-ISP Down' };
  assert.equal(config.matchesSubject(ticket.subject), true);
  assert.equal(decide(ticket, config), 'eligible_ordinary_internet');
  assert.deepEqual(config.resolveFor('eligible_ordinary_internet').catalog, ['Infrastructure', 'Server room equipment', 'UPS']);
  assert.equal(decide({ ...ticket, subject: 'DNSS packet loss' }, config), 'skip_subject');
  assert.equal(decide({ ...ticket, subject: 'DNSS packet loss' }, parseClosureConfig(extraOrdinaryRules)), 'eligible');
  assert.equal(decide({ ...ticket, subject: '其他告警' }, config), 'skip_subject');
  assert.equal(decide({ ...ticket, planned: undefined }, config), 'review_unreadable_planned_field');
  assert.equal(decide({ ...ticket, planned: { present: true, value: '其它分析内容' } }, config), 'skip_planned_event');
  assert.equal(decide({ ...ticket, planned: { present: true, value: '相关计划事件，测试分类' } }, config), 'eligible_planned_custom');
});

test('新增普通分支也校验重复 ID、结构和选项路径', () => {
  assert.throws(() => parseClosureConfig(extraOrdinaryRules.replace('id: internet_a', 'id: internet')), /id 重复/);
  assert.throws(() => parseClosureConfig(extraOrdinaryRules.replace('  branches:\n    - id: internet', '  branches: null\n    - id: internet')));
  assert.throws(() => parseClosureConfig(extraOrdinaryRules.replace('[Infrastructure, Server room equipment, UPS]', '[]')), /非空文本列表/);
});

test('跨页从实际列表末尾开始，先倒序再限制检查数量', () => {
  const pages = [['IT-1', 'IT-2'], ['IT-3', 'IT-4'], ['IT-5']];
  assert.deepEqual(reverseQueue(pages.flat(), 3), ['IT-5', 'IT-4', 'IT-3']);
  assert.deepEqual(reverseQueue(pages.flat(), 1), ['IT-5']);
  assert.deepEqual(reverseQueue([], 10), []);
  assert.deepEqual(reverseQueue(pages.flat(), null), ['IT-5', 'IT-4', 'IT-3', 'IT-2', 'IT-1']);
});

test('Subject 中的 SPOKE 和 VSPOKE 均满足标题规则', () => {
  assert.equal(decide(eligible), 'eligible_ordinary_network');
  for (const subject of [
    'CNXIY16-F11-M-121G-SPOKE01',
    'CNXIY16-F11-M-121F-SPOKE01',
    'CNXIY16-F11-M-121F-VSPOKE01',
    'CNXIY16-F11-M-121G-VSPOKE:ISP-CM',
    '[Baseline-Net]-SDWAN-Fortinet Vspoke SLAs CNXIY18-F13-M-121G-VSPOKE:SD-WAN [HC_SZX13]:[SZX13-CT]',
    'CNDLC08-F07-M-121G-VSPOKE_[Baseline-Net]-SDWAN-Fortinet Vspoke Icmp Packet Loss Greater than 20%',
    'CNXIY17-F05-M-F121G-VSPOKE01',
    'cnxiy16-f11-m-121g-vspoke:isp-cm',
  ]) assert.equal(decide({ ...eligible, subject }), 'eligible_ordinary_network', subject);
  for (const subject of ['S5731-AVSW08', 'CNHFE06-F05-M-R450-GW01', '121G-NOTSPOKE', 'VSPOKE']) {
    assert.equal(decide({ ...eligible, subject }), 'skip_subject', subject);
  }
});

test('SPOKE 和 VSPOKE 不再依赖恢复状态，但仍检查计划事件', () => {
  const vspoke = { ...eligible, subject: 'CNXIY16-F11-M-121G-VSPOKE:ISP-CM' };
  assert.equal(decide(vspoke), 'eligible_ordinary_network');
  assert.equal(decide({ ...vspoke, alertStatus: 'Open' }), 'eligible_ordinary_network');
  assert.equal(decide({ ...eligible, alertStatus: 'Firing' }), 'eligible_ordinary_network');
  assert.equal(decide({ ...vspoke, planned: { present: true, value: '相关计划事件 IT-50425247' } }), 'skip_planned_event');
});

test('已关闭的 IT-50603796 不会再次提交', () => {
  assert.equal(decide({ ...eligible, status: 'Closed', subject: 'S5731-AVSW08',
    planned: { present: true, value: '相关计划内事件工单 IT-50425247' } }), 'skip_finished');
});

test('计划事件字段任何有效内容都会阻止普通 Network Issues 分支', () => {
  for (const value of ['相关计划内事件 IT-50425247', 'There is a correlated planned event.', 'No correlated planned event', '不存在一个相关的计划内事件。线路']) {
    assert.equal(decide({ ...eligible, planned: { present: true, value } }), 'skip_planned_event');
  }
});

test('空富文本、空白和占位符按空内容处理，读取失败不按空处理', () => {
  for (const value of ['', ' \u200b\n\ufeff\u00a0 ', '--', '—']) {
    assert.equal(meaningful(value), false);
    assert.equal(decide({ ...eligible, planned: { present: true, value } }), 'eligible_ordinary_network');
  }
  assert.equal(decide({ ...eligible, planned: undefined }), 'review_unreadable_planned_field');
});

test('处理中以外状态和缺失 Subject 不会提交', () => {
  assert.equal(decide({ ...eligible, status: 'To be handled' }), 'skip_status');
  assert.equal(decide({ ...eligible, subject: '\u200b' }), 'review_missing_subject');
});

test('新增 ADSL 和 INTERNET A/B/C/D 标题命中同一分支', () => {
  for (const subject of [
    '【办公网络】CNHGH45-ADSL-B_[Baseline-Net]-ADSL-ISP Down',
    'adsl-isp down',
    ...['A', 'B', 'C', 'D'].map(letter => `ROOTP03-INTERNET-${letter}_[Baseline-Net]-ISP Down`),
    'internet-b: Circuit Traffic Utilization',
  ]) {
    assert.equal(matchesSubject(subject), true, subject);
    assert.equal(decide({ ...eligible, subject }), 'eligible_ordinary_network', subject);
  }
  for (const subject of ['INTERNET-|', 'INTERNET-E', 'INTERNET-ADSL', 'INTERNET-A1', 'INTERNET-AB']) {
    assert.equal(matchesSubject(subject), false, subject);
  }
});

test('仅 Description 中的关联告警命中时不进入分支，标题不能回退到 Description', () => {
  const description = 'ADSL-ISP Down INTERNET-C 121G-VSPOKE';
  assert.equal(decide({ ...eligible, subject: 'R450-GW01_[Baseline-Net]-GW Tunnel Down', description }), 'skip_subject');
  assert.equal(decide({ ...eligible, subject: undefined, description }), 'review_missing_subject');
  assert.equal(decide({ ...eligible, subject: 'INTERNET-D', description: '' }), 'eligible_ordinary_network');
});

test('默认是预演，提交必须显式指定', () => {
  assert.equal(parseArgs(['run']).submit, false);
  assert.equal(parseArgs(['run']).max, null);
  assert.equal(parseArgs(['run']).maxScan, null);
  assert.equal(parseArgs(['run', '--submit', '--max', '5']).submit, true);
  assert.equal(parseArgs(['run', '--submit', '--max', '5']).max, 5);
  assert.equal(parseArgs(['run', '--ticket', '50973593']).ticket, 'IT-50973593');
});

test('提交确认要求已解决或已关闭状态以及非空解决时间', () => {
  assert.equal(resolvedSuccessfully({ status: 'Resolved' }, '2026-11-05 21:34:47'), true);
  assert.equal(resolvedSuccessfully({ status: 'Closed' }, '2026-11-05 21:34:47'), true);
  assert.equal(resolvedSuccessfully({ status: 'In progress' }, '2026-11-05 21:34:47'), false);
  assert.equal(resolvedSuccessfully({ status: 'Resolved' }, '--'), false);
});

test('错误参数不会静默启用提交或忽略显式数量限制', () => {
  for (const args of [
    ['run', '--submt'], ['run', '--max', '0'], ['run', '--max', 'Infinity'],
    ['run', '--max'], ['run', '--headless'], ['login', '--submit'],
    ['run', '--submit', '--submit'], ['run', '--ticket', 'abc'],
  ]) assert.throws(() => parseArgs(args));
  assert.equal(normalize(' Recovered\u200b '), 'Recovered');
});

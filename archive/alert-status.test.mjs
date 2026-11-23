import test from 'node:test';
import assert from 'node:assert/strict';
import { isAlertRecovered, readAlertStatus, checkAlertRecovered } from './alert-status.mjs';

test('存档的恢复状态函数仍保留原精确判断', () => {
  assert.equal(isAlertRecovered('Recovered'), true);
  assert.equal(isAlertRecovered(' Recovered\u200b '), true);
  for (const value of ['Open', 'Firing', 'recovered', '', undefined, null]) {
    assert.equal(isAlertRecovered(value), false);
  }
  assert.equal(typeof readAlertStatus, 'function');
  assert.equal(typeof checkAlertRecovered, 'function');
});

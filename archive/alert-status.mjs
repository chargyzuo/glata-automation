// Preserved legacy helpers. Reused by the direct/single-ticket branch only;
// the Alarm_recovered batch branch does not call them.
import { normalize } from '../rules.mjs';

export function isAlertRecovered(status) {
  return normalize(status) === 'Recovered';
}

export async function readAlertStatus(page) {
  const label = page.getByRole('tabpanel', { name: 'Details', exact: true })
    .getByText('Alert Status', { exact: true });
  const count = await label.count();
  if (count !== 1) throw new Error(`字段 Alert Status 数量异常: ${count}`);
  const value = await label.evaluate(el => {
    if (!el.nextElementSibling) throw new Error('Alert Status 内容节点缺失');
    return el.nextElementSibling.innerText ?? el.nextElementSibling.textContent ?? '';
  });
  return normalize(value);
}

export async function checkAlertRecovered(page) {
  return isAlertRecovered(await readAlertStatus(page));
}

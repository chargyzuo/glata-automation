export const BASE = 'https://glata.bytedance.net';
export const VIEWS = Object.freeze({
  Alarm_recovered: Object.freeze({ name: 'Alarm_recovered', id: '49787', url: `${BASE}/ens/engineer/ticketView?viewId=49787` }),
  Alarm_unrecovered: Object.freeze({ name: 'Alarm_unrecovered', id: '49788', url: `${BASE}/ens/engineer/ticketView?viewId=49788` }),
  Alarm: Object.freeze({ name: 'Alarm', id: '48103', url: `${BASE}/ens/engineer/ticketView?viewId=48103` }),
});
export const DEFAULT_VIEW = VIEWS.Alarm_recovered;

export function getView(name = DEFAULT_VIEW.name) {
  if (!Object.hasOwn(VIEWS, name)) throw new Error(`未知视图: ${name}`);
  return VIEWS[name];
}

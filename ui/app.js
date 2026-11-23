const byId = id => document.getElementById(id);
const form = byId('job-form');
const action = byId('action');
const mode = byId('mode');
const run = byId('run');
const output = byId('output');
const notice = byId('notice');
let job = null;
let sending = false;
let statusRequest = 0;

function fields() {
  const concurrent = action.value === 'concurrent';
  const single = action.value === 'close';
  const submit = mode.value === 'submit';
  for (const [name, show] of [
    ['workers', concurrent], ['ticket', !concurrent], ['max', !single],
    ['scan', !single], ['headless', submit],
  ]) {
    const field = byId(name + '-field');
    field.hidden = !show;
    field.querySelector('input').disabled = !show;
  }
  byId('ticket').required = single;
  byId('ticket-hint').hidden = single;
  run.textContent = submit ? '开始正式关单' : '开始预演';
  run.classList.toggle('submit', submit);
  byId('mode-hint').textContent = submit
    ? '符合条件的工单将自动提交 Confirm。'
    : '预演会保留填好的表单供你检查。';
}

function render() {
  const busy = sending || Boolean(job?.running);
  for (const id of ['login', 'export', 'settings']) byId(id).disabled = busy;
  const paused = job?.pause;
  byId('pause').hidden = !paused;
  byId('continue').disabled = sending;
  if (paused) {
    const login = paused === 'login';
    byId('continue').textContent = login ? '已登录，保存会话' : '结束预演';
    byId('pause-hint').textContent = login
      ? '请在 Glata 窗口完成登录并看到工单列表，再保存会话。'
      : '请在 Glata 窗口检查已填好的表单。结束预演会关闭浏览器。';
  }
  byId('status').textContent = paused ? '等待操作'
    : job?.running ? '运行中'
    : !job ? '就绪'
    : job.code === 0 ? (job.action === 'login' ? '会话已保存' : '已完成')
    : job.code === 2 ? '工单已跳过' : '任务出错';
  const text = job?.output || (job?.running ? '正在打开浏览器…' : '任务日志会显示在这里。');
  if (output.textContent !== text) {
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    output.textContent = text;
    if (follow) output.scrollTop = output.scrollHeight;
  }
}

function showError(error) {
  notice.textContent = error.message;
  notice.hidden = false;
}

async function request(path, input) {
  const response = await fetch(path, input === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data.job;
}

async function refresh() {
  if (sending) return;
  const seq = ++statusRequest;
  try {
    const state = await request('/api/job');
    if (seq === statusRequest) {
      job = state;
      render();
    }
  } catch {
    if (seq === statusRequest) showError(new Error('控制台连接中断，请检查终端。'));
  }
}

async function send(path, data) {
  if (sending) return;
  sending = true;
  statusRequest++;
  notice.hidden = true;
  render();
  try { job = await request(path, data); }
  catch (error) { showError(error); }
  finally { sending = false; render(); }
}

action.addEventListener('change', fields);
mode.addEventListener('change', fields);
byId('login').addEventListener('click', () => send('/api/start', { action: 'login' }));
byId('export').addEventListener('click', () => send('/api/start', { action: 'subjects' }));
byId('continue').addEventListener('click', () => send('/api/continue', { id: job?.id }));
form.addEventListener('submit', event => {
  event.preventDefault();
  const submit = mode.value === 'submit';
  send('/api/start', {
    action: action.value, submit, headless: submit && byId('headless').checked,
    workers: byId('workers').value, ticket: byId('ticket').value.trim(),
    max: byId('max').value, maxScan: byId('max-scan').value,
  });
});

fields();
render();
refresh();
setInterval(refresh, 900);

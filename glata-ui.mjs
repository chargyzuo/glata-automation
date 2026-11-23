import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './rules.mjs';
import { parseConcurrentArgs } from './concurrent.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const host = '127.0.0.1';
const port = 4317;
const origin = 'http://' + host + ':' + port;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
let current = null;

function commandFor(input) {
  if (!input || typeof input !== 'object') throw new Error('任务参数无效');
  const { action, submit, headless, ticket, workers, max, maxScan } = input;
  const args = [];
  if (action === 'login' || action === 'subjects') {
    return { script: 'glata.mjs', args: [action] };
  }
  if (!['run', 'concurrent', 'close'].includes(action) ||
      typeof submit !== 'boolean' || typeof headless !== 'boolean') {
    throw new Error('请选择运行方式');
  }
  if (action === 'close') args.push('close', String(ticket ?? ''));
  if (action === 'run') {
    args.push('run');
    if (ticket) args.push('--ticket', String(ticket));
  }
  if (action === 'concurrent') args.push('--workers', String(workers ?? 2));
  if (action !== 'close') {
    if (max) args.push('--max', String(max));
    if (maxScan) args.push('--max-scan', String(maxScan));
  }
  args.push(submit ? '--submit' : '--dry-run');
  if (headless) args.push('--headless');
  if (action === 'concurrent') {
    parseConcurrentArgs(args);
    return { script: 'glata-concurrent.mjs', args };
  }
  parseArgs(args);
  return { script: 'glata.mjs', args };
}

function start(input) {
  const { script, args } = commandFor(input);
  const child = fork(new URL(script, import.meta.url), args, {
    cwd: root, execArgv: [], detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const job = { id: randomUUID(), action: input.action, running: true, pause: null, code: null, output: '' };
  current = { job, child };
  function append(text) { job.output = (job.output + text).slice(-60000); }
  child.stdout.setEncoding('utf8').on('data', append);
  child.stderr.setEncoding('utf8').on('data', append);
  child.on('message', message => {
    if (message?.type === 'pause' && ['login', 'preview'].includes(message.kind)) job.pause = message.kind;
  });
  child.once('error', error => append(error.message + '\n'));
  child.once('close', code => {
    job.running = false;
    job.pause = null;
    job.code = code ?? 1;
  });
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readInput(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error('任务参数太长');
  }
  return JSON.parse(body);
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'");
  if (request.headers.host !== host + ':' + port) return json(response, 403, { error: '请使用本地控制台地址' });

  try {
    if (request.method === 'GET') {
      if (request.url === '/api/job') return json(response, 200, { job: current?.job ?? null });
      const asset = assets.get(request.url);
      if (asset) {
        const [file, type] = asset;
        const content = await readFile(new URL('ui/' + file, import.meta.url));
        response.writeHead(200, { 'Content-Type': type });
        return response.end(content);
      }
    }
    if (request.method === 'POST' && ['/api/start', '/api/continue'].includes(request.url)) {
      if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
        return json(response, 403, { error: '请通过本地控制台操作' });
      }
      const input = await readInput(request);
      if (request.url === '/api/start') {
        if (current?.job.running) return json(response, 409, { error: '已有任务在运行' });
        start(input);
      } else {
        if (!current?.job.pause || input?.id !== current.job.id || !current.child.connected) {
          return json(response, 409, { error: '当前任务没有等待操作' });
        }
        const { child, job } = current;
        const pause = job.pause;
        job.pause = null;
        try {
          await new Promise((resolve, reject) => {
            child.send({ type: 'continue' }, error => error ? reject(error) : resolve());
          });
        } catch (error) {
          if (job.running) job.pause = pause;
          throw error;
        }
      }
      return json(response, 200, { job: current.job });
    }
    return json(response, 404, { error: '页面不存在' });
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '端口已占用，控制台地址为 ' + origin : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log('Glata 本地控制台已启动 ' + origin));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (current?.job.running) {
      console.log('请在网页中完成当前任务，任务结束后再退出控制台。');
      return;
    }
    server.close();
  });
}

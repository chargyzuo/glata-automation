import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export function canPause() {
  return stdin.isTTY || process.connected;
}

export async function manualPause(kind, message) {
  if (process.connected) {
    await new Promise((resolve, reject) => {
      function cleanup() {
        process.off('message', onMessage);
        process.off('disconnect', onDisconnect);
      }
      function onMessage(command) {
        if (command?.type !== 'continue') return;
        cleanup();
        resolve();
      }
      function onDisconnect() {
        cleanup();
        reject(new Error('本地控制台已断开'));
      }
      process.on('message', onMessage);
      process.once('disconnect', onDisconnect);
      process.send({ type: 'pause', kind }, error => {
        if (!error) return;
        cleanup();
        reject(error);
      });
    });
    return;
  }
  if (!stdin.isTTY) throw new Error(`${message} 请在交互式终端运行。`);
  const rl = createInterface({ input: stdin, output: stdout });
  try { await rl.question(`${message}\n按 Enter 继续。`); }
  finally { rl.close(); }
}

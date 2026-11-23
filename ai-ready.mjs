import { randomUUID } from 'node:crypto';

const MESSAGE = 'AI form filling completed';

export async function armAiCompletion(page, { timeoutMs = 120000, staleTimeoutMs = 15000 } = {}) {
  // Do not mistake a previous ticket's still-visible toast for this action.
  await page.getByText(MESSAGE, { exact: true }).waitFor({ state: 'hidden', timeout: staleTimeoutMs });
  const token = randomUUID();
  await page.evaluate(({ token, message }) => {
    window.__glataAiCompletionWatch?.observer?.disconnect();
    const watch = { token, completed: false, observedAt: null, observer: null };
    const check = () => {
      const found = [...document.querySelectorAll('.ai-toast-text')].some(el => {
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        const style = getComputedStyle(el);
        return text === message && el.getClientRects().length > 0 &&
          style.visibility !== 'hidden' && style.visibility !== 'collapse';
      });
      if (found) {
        watch.completed = true;
        watch.observedAt = Date.now();
        watch.observer.disconnect();
      }
    };
    watch.observer = new MutationObserver(check);
    window.__glataAiCompletionWatch = watch;
    watch.observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden'],
    });
    check();
  }, { token, message: MESSAGE });

  async function dispose() {
    if (page.isClosed()) return;
    await page.evaluate(token => {
      const watch = window.__glataAiCompletionWatch;
      if (watch?.token !== token) return;
      watch.observer.disconnect();
      delete window.__glataAiCompletionWatch;
    }, token);
  }

  return {
    async wait() {
      try {
        await page.waitForFunction(token => {
          const watch = window.__glataAiCompletionWatch;
          return watch?.token === token && watch.completed;
        }, token, { timeout: timeoutMs, polling: 100 });
        return await page.evaluate(token => {
          const watch = window.__glataAiCompletionWatch;
          if (watch?.token !== token || !watch.completed) throw new Error('AI 提示监听状态失效');
          return { message: 'AI form filling completed', observedAt: watch.observedAt };
        }, token);
      } catch (error) {
        throw new Error(`未确认本次 AI 自动填充完成，停止填写（等待上限 ${timeoutMs / 1000} 秒）`, { cause: error });
      } finally {
        await dispose();
      }
    },
    dispose,
  };
}

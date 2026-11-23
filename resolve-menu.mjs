// Arco dropdowns may open on hover. Clicking an already-hover-open trigger can
// close it again, so use the visible menu as the source of truth.
export async function openResolveMenu(page, { hoverTimeoutMs = 1500, timeoutMs = 15000 } = {}) {
  const action = page.getByRole('menuitem', { name: 'Resolve', exact: true });
  if (await action.isVisible()) return { action, openedBy: 'already_visible' };
  const operation = page.getByRole('button', { name: 'Operation', exact: true });
  await operation.hover();
  try {
    await action.waitFor({ state: 'visible', timeout: hoverTimeoutMs });
    return { action, openedBy: 'hover' };
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
  }
  if (await action.isVisible()) return { action, openedBy: 'hover' };
  await operation.click();
  await action.waitFor({ state: 'visible', timeout: timeoutMs });
  return { action, openedBy: 'click' };
}

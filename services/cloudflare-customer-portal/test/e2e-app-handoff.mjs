// Record the real callback request, then cancel this test-only external navigation so assertions
// can inspect the retained portal document. A 204 mock leaves Chromium's navigation pending.
export async function captureAppHandoffs(page, pattern) {
  const callbacks = [];
  await page.route(pattern, (route) => {
    callbacks.push(route.request().url());
    return route.abort("aborted");
  });
  return callbacks;
}

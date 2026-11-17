// Synthetic browser smoke test. Start Vite locally first; all external requests are intercepted.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = process.env.AUDIT_ORIGIN ?? 'http://127.0.0.1:14820';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Use a loopback test server only');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const failures = [];
const account = { email: 'audit@example.invalid', nickname: 'Synthetic audit', locale: 'en', time_zone: 'America/Chicago', usage_region: 'US', registered_at: null, owner_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === origin) return route.continue();
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  let body;
  if (url.pathname.endsWith('/account')) {
    if (request.method() === 'PATCH') Object.assign(account, request.postDataJSON().account);
    body = { account };
  } else if (url.pathname.endsWith('/finance')) body = { currency: null, version: 'synthetic-empty', statement_count: 0, transaction_count: 0 };
  else if (url.pathname.endsWith('/statements')) body = { statements: [] };
  else if (url.pathname.endsWith('/transactions')) body = { transactions: [], next_after_id: null };
  else if (url.pathname.endsWith('/rules')) body = { rules: [] };
  else if (url.pathname.endsWith('/categories')) body = { categories: [] };
  else { failures.push(`Blocked unexpected external request: ${url.pathname}`); return route.abort(); }
  return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
});
await context.addInitScript(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('billie.locale', 'en');
  sessionStorage.setItem('billie.token', 'synthetic-token');
});
const page = await context.newPage();
page.on('pageerror', (error) => failures.push(error.message));
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true });
try {
  await page.goto(origin);
  await page.getByRole('navigation').waitFor();
  await page.getByRole('button', { name: 'Manual', exact: true }).click();
  await nav('Accounts').click();
  await page.getByLabel(/^Book currency/).selectOption('USD');
  for (const [name, type, opening] of [['Audit Checking', 'checking', '1000'], ['Audit Card', 'credit_card', '0']]) {
    await page.getByRole('button', { name: 'Add account', exact: true }).click();
    const form = page.getByRole('form', { name: 'New account' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.locator('select').first().selectOption(type);
    await form.getByLabel(/^Opening balance/).fill(opening);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.waitFor({ state: 'detached' });
  }
  await nav('Transactions').click();
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  let form = page.getByRole('form', { name: 'New entry' });
  await form.getByLabel('Amount', { exact: true }).fill('80.00');
  await form.getByLabel(/^Account/).selectOption({ label: 'Audit Card' });
  await form.getByLabel(/^Category/).selectOption('Shopping');
  await form.getByLabel(/^Merchant/).fill('Synthetic shop');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  await page.getByText('Synthetic shop', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  form = page.getByRole('form', { name: 'New entry' });
  await form.getByRole('radio', { name: 'Refund', exact: true }).click();
  await form.getByLabel('Amount', { exact: true }).fill('30.00');
  await form.getByLabel(/^Account/).selectOption({ label: 'Audit Card' });
  const original = form.locator('select').filter({ has: page.locator('option', { hasText: 'Synthetic shop' }) });
  await original.selectOption({ index: 1 });
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  await nav('Accounts').click();
  await page.getByRole('heading', { name: 'Accounts', exact: true }).waitFor();
  assert.match(await page.locator('body').innerText(), /\$950\.00/);
  await page.getByRole('button', { name: 'Default', exact: true }).click();
  await nav('Reports').click();
  await page.getByRole('button', { name: 'Export CSV', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/billieweather-audit-browser.png', fullPage: true });
  assert.deepEqual(failures, []);
  console.log('PASS: Chromium manual accounts, expense, linked refund, $950 net worth, mode switch, lazy reports; no external traffic or browser errors.');
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(-3000));
  await page.screenshot({ path: '/tmp/billieweather-audit-browser-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
}

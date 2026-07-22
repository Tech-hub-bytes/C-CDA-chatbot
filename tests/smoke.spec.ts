import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let testArtifactsDir: string;
let consoleLogs: string[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let failedRequests: string[] = [];

test('smoke test - chat page loads', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'C-CDA Chatbot' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'C-CDA Patient Chat' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Documents' })).toBeVisible();
  await expect(
    page.getByPlaceholder('Ask a question about the C-CDA health summary…'),
  ).toBeVisible();
});

test('smoke test - documents page navigates', async ({ page }) => {
  await page.goto('/files');
  await expect(page.getByRole('link', { name: 'Documents' })).toBeVisible();
});

test.beforeEach(async ({ page }) => {
  consoleLogs = [];
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];

  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (!text.trim() || /^%[osd]$/.test(text.trim())) return;
    const location = msg.location();
    const locationStr = location.url
      ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}`
      : '';
    consoleLogs.push(`[${type}] ${text}${locationStr}`);
    if (type === 'error') consoleErrors.push(`${text}${locationStr}`);
  });

  page.on('pageerror', (error) => {
    pageErrors.push(`Page error: ${error.message}\nStack: ${error.stack || 'No stack trace available'}`);
  });

  page.on('requestfailed', (request) => {
    failedRequests.push(`Failed request: ${request.url()} - ${request.failure()?.errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  const screenshotPath = join(testArtifactsDir, `${testName}-app-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  writeFileSync(
    logsPath,
    [
      '=== Console Logs ===',
      ...consoleLogs,
      '\n=== Console Errors ===',
      ...consoleErrors,
      '\n=== Page Errors ===',
      ...pageErrors,
      '\n=== Failed Requests ===',
      ...failedRequests,
    ].join('\n'),
    'utf-8',
  );
  await page.close();
});

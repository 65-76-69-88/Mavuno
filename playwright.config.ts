import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';

config({ quiet: true });
const browserCache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : '';
const cachedChromium = browserCache && existsSync(browserCache)
  ? readdirSync(browserCache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .flatMap(name => ['chrome-win64', 'chrome-win'].map(directory => join(browserCache, name, directory, 'chrome.exe'))).find(existsSync)
  : undefined;

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  outputDir: 'output/browser/test-results',
  reporter: [['list'], ['html', { outputFolder: 'output/browser/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3001',
    viewport: { width: 1280, height: 1000 },
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || cachedChromium },
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3001/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { REVIEWER_SECRET: process.env.REVIEWER_SECRET || 'synthetic-browser-test-reviewer', DATA_DIR: process.env.DATA_DIR || 'output/browser/server-data' },
  },
});

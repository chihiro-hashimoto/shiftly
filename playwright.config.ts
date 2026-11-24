import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'off' },
  webServer: { command: 'node scripts/serve-preview.mjs', url: 'http://127.0.0.1:4173/', reuseExistingServer: true, timeout: 30_000 },
  projects: [
    { name: 'ipad-landscape', use: { ...devices['iPad Pro 11 landscape'], browserName: 'chromium' } },
    { name: 'ipad-portrait', use: { ...devices['iPad Pro 11'], browserName: 'chromium' } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, browserName: 'chromium' } },
  ],
});

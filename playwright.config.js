import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  workers: 2,
  use: {
    baseURL: 'http://localhost:8000',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'python3 -m http.server 8000',
    port: 8000,
    reuseExistingServer: true,
    cwd: '.',
  },
});
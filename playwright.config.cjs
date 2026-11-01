const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8080',
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: 'node server.js',
    port: 8080,
    timeout: 15000,
    reuseExistingServer: !process.env.CI,
    env: {
      NODE_ENV: 'test',
      E2E: 'true',
      PORT: '8080',
      GEMINI_API_KEY: '',
      GOOGLE_CLOUD_API_KEY: '',
      FIREBASE_PROJECT_ID: '',
      FIREBASE_CLIENT_EMAIL: '',
      FIREBASE_PRIVATE_KEY: '',
    },
  },
});

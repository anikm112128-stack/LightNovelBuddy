const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    fullyParallel: true,
    use: {
        baseURL: 'http://127.0.0.1:4173',
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            args: ['--no-sandbox']
        } : {}
    },
    webServer: {
        command: 'node tests/serve.cjs',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: false
    }
});

# Browser tests

Install Node.js dependencies with `npm install`, install Chromium with `npx playwright install chromium` (and its system dependencies if needed), then run `npm test`.

These tests serve the local frontend and mock its API calls in the browser. They do not contact the deployed backend or the AI provider and do not replace integration tests against a real backend.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

// Never contact the deployed API: each test gets a fresh in-memory backend.
async function mockApi(page) {
    const state = { chapters: [], memories: [], characters: [], idempotency: {}, nextId: 1, failChapterSave: false, failChapterGet: false, dropNextSaveResponse: false, validationError: null, delayChapterSave: 0, chapterPosts: 0 };
    await page.route('https://lightnovelbuddy.onrender.com/**', async route => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        const method = req.method();
        if (method === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' } });
            return;
        }
        let status = 200, body = {};
        if (path === '/api/health') body = { status: 'online' };
        else if (path === '/api/dashboard') body = {
            chapters: state.chapters.length,
            words: state.chapters.reduce((sum, c) => sum + c.content.trim().split(/\s+/).filter(Boolean).length, 0),
            memories: state.memories.length, characters: state.characters.length
        };
        else if (path.startsWith('/api/ai/')) body = { result: 'AI test response' };
        else {
            const match = path.match(/^\/api\/(chapters|memories|characters)(?:\/(\d+))?$/);
            if (!match) { status = 404; body = { detail: 'Not found' }; }
            else {
                const [, resource, id] = match;
                const items = state[resource];
                const index = items.findIndex(item => item.id === Number(id));
                const idemKey = req.headers()['idempotency-key'];
                if (method === 'GET' && !id) body = [...items].reverse();
                else if (method === 'GET' && index >= 0 && resource === 'chapters' && state.failChapterGet) { status = 503; body = { detail: 'Simulated failure' }; }
                else if (method === 'GET' && index >= 0) body = items[index];
                else if (method === 'POST') {
                    if (resource === 'chapters') {
                        state.chapterPosts++;
                        if (state.delayChapterSave) await new Promise(resolve => setTimeout(resolve, state.delayChapterSave));
                    }
                    if (state.validationError) { status = 422; body = { detail: state.validationError }; }
                    else if (resource === 'chapters' && state.failChapterSave) { status = 503; body = { detail: 'Simulated failure' }; }
                    else if (idemKey && state.idempotency[idemKey]) {
                        Object.assign(state.idempotency[idemKey], req.postDataJSON());
                        body = { id: state.idempotency[idemKey].id };
                    } else {
                        const item = { ...req.postDataJSON(), id: state.nextId++ };
                        items.push(item);
                        if (idemKey) state.idempotency[idemKey] = item;
                        body = { id: item.id };
                        if (state.dropNextSaveResponse) {
                            state.dropNextSaveResponse = false;
                            await route.abort('connectionreset');
                            return;
                        }
                    }
                } else if (method === 'PUT' && index >= 0) { Object.assign(items[index], req.postDataJSON()); body = { message: 'Updated' }; }
                else if (method === 'DELETE' && index >= 0) { items.splice(index, 1); body = { message: 'Deleted' }; }
                else { status = 404; body = { detail: 'Not found' }; }
            }
        }
        await route.fulfill({ status, json: body, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    });
    return state;
}
async function open(page) { await page.goto('/'); await expect(page.locator('#backendStatus')).toContainText('Backend connected'); }
async function nav(page, section) { await page.locator(`.nav[data-page="${section}"]`).click(); }

test('restores new and edited drafts and keeps draft on failed save', async ({ page }) => {
    const api = await mockApi(page); await open(page); await nav(page, 'editor');
    await page.locator('#chapterTitle').fill('A new chapter');
    await page.locator('#chapterText').fill('The draft survives.');
    page.on('dialog', dialog => dialog.accept());
    await page.reload(); await nav(page, 'editor');
    await expect(page.locator('#chapterText')).toHaveValue('The draft survives.');
    await expect(page.locator('#editStatus')).toContainText('Recovered');
    api.failChapterSave = true;
    await page.locator('#saveChapterButton').click();
    await expect(page.locator('#toast')).toContainText('Could not save chapter');
    await page.reload(); await nav(page, 'editor');
    await expect(page.locator('#chapterText')).toHaveValue('The draft survives.');
    api.failChapterSave = false;
    await page.locator('#saveChapterButton').click();
    await expect(page.locator('#chapterList')).toContainText('A new chapter');
    await page.locator('#chapterList').getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#chapterText')).toHaveValue('The draft survives.');
    await page.locator('#chapterText').fill('Unsaved revision');
    await page.reload(); await nav(page, 'editor');
    await expect(page.locator('#chapterText')).toHaveValue('Unsaved revision');
    await expect(page.locator('#saveChapterButton')).toHaveText('Save changes');
    await page.locator('#saveChapterButton').click();
    await expect.poll(() => api.chapters[0].content).toBe('Unsaved revision');
});

test('prevents duplicate saves and keeps typing made while saving', async ({ page }) => {
    const api = await mockApi(page); api.delayChapterSave = 500; await open(page); await nav(page, 'editor');
    await page.locator('#chapterTitle').fill('Slow save');
    await page.locator('#chapterText').fill('First version');
    await page.locator('#saveChapterButton').evaluate(button => { button.click(); button.click(); });
    await page.locator('#chapterText').fill('Newer version');
    await expect(page.locator('#saveChapterButton')).toHaveText('Save changes');
    expect(api.chapterPosts).toBe(1);
    expect(api.chapters[0].content).toBe('First version');
    await expect(page.locator('#chapterText')).toHaveValue('Newer version');
    await page.locator('#saveChapterButton').click();
    await expect.poll(() => api.chapters[0].content).toBe('Newer version');
    expect(api.chapters).toHaveLength(1);
});

test('confirms before replacing unsaved writing', async ({ page }) => {
    const api = await mockApi(page); api.chapters.push({ id: 22, title: 'Saved chapter', content: 'Saved' });
    await open(page); await nav(page, 'editor'); await expect(page.locator('#chapterList')).toContainText('Saved chapter');
    await page.locator('#chapterTitle').fill('Unsaved'); await page.locator('#chapterText').fill('Keep this');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#chapterList').getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#chapterText')).toHaveValue('Keep this');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#chapterList').getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#chapterText')).toHaveValue('Saved');
});


test('a failed chapter load preserves the existing draft', async ({ page }) => {
    const api = await mockApi(page); api.chapters.push({ id: 7, title: 'Saved', content: 'Saved text' });
    await open(page); await nav(page, 'editor');
    await page.locator('#chapterTitle').fill('Unsaved'); await page.locator('#chapterText').fill('Keep this draft');
    api.failChapterGet = true;
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#chapterList').getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#toast')).toContainText('Could not open chapter');
    await expect(page.locator('#chapterText')).toHaveValue('Keep this draft');
    page.once('dialog', dialog => dialog.accept());
    await page.reload(); await nav(page, 'editor');
    await expect(page.locator('#chapterText')).toHaveValue('Keep this draft');
});

test('warns when local draft storage is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
        Storage.prototype.setItem = function () { throw new DOMException('Storage full', 'QuotaExceededError'); };
    });
    await mockApi(page); await open(page); await nav(page, 'editor');
    await page.locator('#chapterText').fill('Important text');
    await expect(page.locator('#toast')).toContainText('Local draft storage is unavailable');
    await expect(page.locator('#chapterText')).toHaveValue('Important text');
});

test('world entries and characters can be edited without losing existing fields', async ({ page }) => {
    const api = await mockApi(page);
    api.memories.push({ id: 10, name: 'Oakhaven', category: 'Kingdom', description: 'Old lore' });
    api.characters.push({ id: 11, name: 'Arthur', personality: 'Secretive', description: 'Old details' });
    await open(page); await nav(page, 'memory');
    await page.getByRole('button', { name: 'Edit Oakhaven' }).click();
    await expect(page.locator('#memoryCategory')).toHaveValue('Kingdom');
    await page.locator('#memoryDescription').fill('New lore'); await page.locator('#saveMemoryButton').click();
    await expect(page.locator('#memoryList')).toContainText('New lore');
    expect(api.memories[0].category).toBe('Kingdom');
    await nav(page, 'characters'); await page.getByRole('button', { name: 'Edit Arthur' }).click();
    await page.locator('#charDescription').fill('New details'); await page.locator('#saveCharacterButton').click();
    await expect(page.locator('#characterList')).toContainText('New details');
    expect(api.characters[0].personality).toBe('Secretive');
    await page.getByRole('button', { name: 'Edit Arthur' }).click();
    await page.locator('#charDescription').fill('Discard?');
    page.once('dialog', dialog => dialog.dismiss()); await page.locator('#cancelCharacterButton').click();
    await expect(page.locator('#charDescription')).toHaveValue('Discard?');
});

test('chapter viewer supports keyboard focus and Escape', async ({ page }) => {
    const api = await mockApi(page); api.chapters.push({ id: 1, title: 'Chapter', content: 'Text' });
    await open(page); await nav(page, 'editor');
    const view = page.locator('#chapterList').getByRole('button', { name: 'View' }); await view.click();
    await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.locator('#closeChapterModal')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeHidden(); await expect(view).toBeFocused();
});

test('mobile menu is compact and closes after navigation', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 }); await mockApi(page); await open(page);
    await expect(page.locator('#sidebarMenu')).toBeHidden();
    expect(await page.locator('.main').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(200);
    await page.getByRole('button', { name: 'Menu' }).click(); await expect(page.locator('#mobileMenuToggle')).toHaveAttribute('aria-expanded', 'true');
    await nav(page, 'editor'); await expect(page.locator('#sidebarMenu')).toBeHidden(); await expect(page.locator('#editor')).toBeVisible();
    await expect(page.locator('#pageTitle')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('automated accessibility checks on each section', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await mockApi(page); await open(page);
    for (const section of ['dashboard', 'editor', 'memory', 'characters', 'grammar', 'consistency', 'description', 'story']) {
        await nav(page, section);
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations, section).toEqual([]);
    }
});

test('safely retries without duplicates when a save response is lost after server saved', async ({ page }) => {
    const api = await mockApi(page); api.dropNextSaveResponse = true;
    await open(page); await nav(page, 'editor');
    await page.locator('#chapterTitle').fill('Lost response chapter');
    await page.locator('#chapterText').fill('Saved once despite dropped response.');
    await page.locator('#saveChapterButton').click();
    await expect(page.locator('#chapterList')).toContainText('Lost response chapter');
    expect(api.chapterPosts).toBe(2);
    expect(api.chapters).toHaveLength(1);
});

test('formats validation array errors and recovers if edited chapter was deleted', async ({ page }) => {
    const api = await mockApi(page);
    api.validationError = [{ loc: ['body', 'title'], msg: 'Value error, Chapter title cannot be blank.' }];
    await open(page); await nav(page, 'editor');
    await page.locator('#chapterTitle').fill('Valid locally');
    await page.locator('#saveChapterButton').click();
    await expect(page.locator('#toast')).toContainText('Chapter title cannot be blank.');
    await expect(page.locator('#toast')).not.toContainText('[object Object]');
    api.validationError = null;
    api.chapters.push({ id: 50, title: 'Deleted externally', content: 'Original' });
    await nav(page, 'editor');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#chapterList').getByRole('button', { name: 'Edit' }).click();
    api.chapters.length = 0;
    await page.locator('#chapterText').fill('Keep my 2000 words');
    await page.locator('#saveChapterButton').click();
    await expect(page.locator('#saveChapterButton')).toHaveText('Save chapter');
    await page.locator('#saveChapterButton').click();
    expect(api.chapters).toHaveLength(1);
    expect(api.chapters[0].content).toBe('Keep my 2000 words');
});

test('narrow mobile viewports handle long unbroken text and Escape closes mobile menu', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const api = await mockApi(page);
    api.chapters.push({ id: 1, title: 'A'.repeat(120), content: 'B'.repeat(260) });
    await open(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.locator('#mobileMenuToggle')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobileMenuToggle')).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Menu' }).click();
    await nav(page, 'editor');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});


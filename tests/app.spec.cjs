const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

// Never contact the deployed API: each test gets a fresh in-memory backend.
async function mockApi(page) {
    const state = { chapters: [], memories: [], characters: [], nextId: 1, failChapterSave: false, failChapterGet: false, delayChapterSave: 0, chapterPosts: 0 };
    await page.route('https://lightnovelbuddy.onrender.com/**', async route => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        const method = req.method();
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
                if (method === 'GET' && !id) body = [...items].reverse();
                else if (method === 'GET' && index >= 0 && resource === 'chapters' && state.failChapterGet) { status = 503; body = { detail: 'Simulated failure' }; }
                else if (method === 'GET' && index >= 0) body = items[index];
                else if (method === 'POST') {
                    if (resource === 'chapters') {
                        state.chapterPosts++;
                        if (state.delayChapterSave) await new Promise(resolve => setTimeout(resolve, state.delayChapterSave));
                    }
                    if (resource === 'chapters' && state.failChapterSave) { status = 503; body = { detail: 'Simulated failure' }; }
                    else { const item = { ...req.postDataJSON(), id: state.nextId++ }; items.push(item); body = { id: item.id }; }
                } else if (method === 'PUT' && index >= 0) { Object.assign(items[index], req.postDataJSON()); body = { message: 'Updated' }; }
                else if (method === 'DELETE' && index >= 0) { items.splice(index, 1); body = { message: 'Deleted' }; }
                else { status = 404; body = { detail: 'Not found' }; }
            }
        }
        await route.fulfill({ status, json: body, headers: { 'Access-Control-Allow-Origin': '*' } });
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

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

let HANDLE = '';
const CLICK_DELAY_MS = 750;
const STEP_RETRY_DELAY_MS = 1000;
const RETRY_WAIT_MS = 5000;
const STALL_RELOAD_MS = 20_000;
const DISAPPEAR_WAIT_ATTEMPTS = 10;
const DELETE_LOOKUP_ATTEMPTS = 5;
const SCROLL_WAIT_MS = 2000;
const MAX_NO_NEW_PASSES = 8;
const DEFAULT_LIMIT = 10;
const DIAGNOSTICS_DIR = path.resolve('diagnostics');

const argv = process.argv.slice(2);
const hasFlag = flag => argv.includes(flag);
const option = (name, fallback) => {
  const prefix = `${name}=`;
  const value = argv.find(arg => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
};

const positionalLimit = argv.find(arg => /^\d+$/.test(arg));
const limit = Number(positionalLimit || option('--limit', DEFAULT_LIMIT));
const cdpUrl = option('--cdp', 'http://127.0.0.1:9222');
const mode = option('--mode', 'posts').toLowerCase();
const dryRun = hasFlag('--dry-run');
let PROFILE_URL = '';
const TARGET_TAB = mode === 'replies'
  ? /^Replies$/i
  : mode === 'reposts'
    ? /^Reposts$/i
    : /^Posts$/i;
const TARGET_LABEL = mode === 'replies'
  ? 'replies'
  : mode === 'reposts'
    ? 'reposts'
    : 'regular posts';
const ACTION_PATTERN = mode === 'reposts'
  ? /^\s*(?:Undo repost|Remove repost|Unrepost)\s*$/i
  : /^\s*Delete(?: post)?\s*$/i;

if (!Number.isInteger(limit) || limit < 1) {
  throw new Error('--limit must be a positive integer');
}
if (!['posts', 'replies', 'reposts'].includes(mode)) {
  throw new Error('--mode must be posts, replies, or reposts');
}

fs.mkdirSync(DIAGNOSTICS_DIR, {recursive: true});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function profileUrl() {
  return mode === 'replies'
    ? `https://x.com/${HANDLE}/with_replies`
    : mode === 'reposts'
      ? `https://x.com/${HANDLE}/reposts`
      : `https://x.com/${HANDLE}`;
}

async function visible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function firstVisible(locator) {
  try {
    const count = await locator.count();
    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      if (await visible(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

async function waitForVisible(locator, label) {
  let attempts = 0;
  while (true) {
    try {
      if (locator && await visible(locator)) return locator;
    } catch {
      // X may replace the node while the page is rendering.
    }
    attempts++;
    if (attempts % 10 === 0) console.log(`Still waiting for ${label}…`);
    await sleep(STEP_RETRY_DELAY_MS);
  }
}

async function clickAndPause(locator, label) {
  let attempts = 0;
  while (true) {
    try {
      await waitForVisible(locator, label);
      await locator.scrollIntoViewIfNeeded();
      await locator.click();
      await sleep(CLICK_DELAY_MS);
      return;
    } catch (error) {
      attempts++;
      if (attempts % 10 === 0) console.log(`Retrying ${label}: ${error.message}`);
      await sleep(STEP_RETRY_DELAY_MS);
    }
  }
}

async function retryButton(page) {
  return firstVisible(page.locator('button, [role="button"]').filter({
    hasText: /^\s*Retry\s*$/i,
  }));
}

async function reloadPage(page, reason) {
  while (true) {
    try {
      console.log(reason);
      await page.reload({waitUntil: 'domcontentloaded'});
      await sleep(RETRY_WAIT_MS);
      return;
    } catch (error) {
      console.log(`Retrying page reload: ${error.message}`);
      await sleep(STEP_RETRY_DELAY_MS);
    }
  }
}

async function reloadAfterRetry(page) {
  while (true) {
    try {
      if (!await retryButton(page)) return false;
      await reloadPage(page, 'Retry button detected; reloading the page.');
      return true;
    } catch (error) {
      console.log(`Retrying page recovery: ${error.message}`);
      await sleep(STEP_RETRY_DELAY_MS);
    }
  }
}

async function selectTargetTab(page) {
  while (true) {
    try {
      const tab = page.getByRole('tab', {name: TARGET_TAB});
      const selected = await tab.first().getAttribute('aria-selected').catch(() => null);
      if (selected !== 'true') await clickAndPause(tab.first(), `${TARGET_LABEL} tab`);
      const currentPath = new URL(page.url()).pathname;
      const expectedPath = mode === 'replies'
        ? `/${HANDLE}/with_replies`
        : mode === 'reposts'
          ? `/${HANDLE}/reposts`
          : `/${HANDLE}`;
      if (currentPath.replace(/\/+$/, '') !== expectedPath) {
        await page.goto(PROFILE_URL, {waitUntil: 'domcontentloaded'});
        await sleep(RETRY_WAIT_MS);
      }
      return;
    } catch (error) {
      console.log(`Retrying ${TARGET_LABEL} tab selection: ${error.message}`);
      await sleep(STEP_RETRY_DELAY_MS);
    }
  }
}

async function discoverHandle(page) {
  let attempts = 0;
  while (true) {
    try {
      const profileHref = await page.locator('[data-testid="AppTabBar_Profile_Link"]')
        .getAttribute('href');
      const profileMatch = profileHref?.match(/^\/([A-Za-z0-9_]+)\/?$/);
      if (profileMatch) return profileMatch[1];

      const accountText = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]')
        .innerText();
      const accountMatch = accountText.match(/@([A-Za-z0-9_]+)/);
      if (accountMatch) return accountMatch[1];
    } catch {
      // Wait for X's account chrome to finish rendering.
    }
    attempts++;
    if (attempts % 10 === 0) console.log('Still waiting to discover the signed-in X account…');
    await sleep(STEP_RETRY_DELAY_MS);
  }
}

async function statusId(article) {
  try {
    const hrefs = await article.locator('a[href*="/status/"]').evaluateAll(links =>
      links.map(link => link.href),
    );
    const match = hrefs.map(href => href.match(/\/status\/(\d+)/)).find(Boolean);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

async function diagnostic(page, label, error) {
  const stem = `${timestamp()}-${label}`;
  const screenshot = path.join(DIAGNOSTICS_DIR, `${stem}.png`);
  const body = path.join(DIAGNOSTICS_DIR, `${stem}.txt`);
  await page.screenshot({path: screenshot, fullPage: false}).catch(() => {});
  const bodyText = await page.locator('body').innerText().catch(() => '');
  fs.writeFileSync(body, `${error?.stack || error || ''}\n\n${bodyText}\n`);
  console.error(`Diagnostic files: ${screenshot} and ${body}`);
}

async function waitForDeletion(page, id) {
  let attempts = 0;
  while (attempts < DISAPPEAR_WAIT_ATTEMPTS) {
    try {
      const stillVisible = await page.locator('article[data-testid="tweet"] a[href*="/status/"]')
        .evaluateAll((links, target) => links.some(link => link.href.includes(`/status/${target}`)), id);
      if (!stillVisible) return true;
      const articleText = await page.locator('article[data-testid="tweet"]')
        .filter({has: page.locator(`a[href*="/status/${id}"]`)}).first()
        .innerText().catch(() => '');
      if (/post is unavailable|post was deleted|removed/i.test(articleText)) return true;
    } catch {
      // The article can be detached while X redraws the timeline.
    }
    attempts++;
    console.log(`Still waiting for post ${id} to disappear…`);
    await sleep(STEP_RETRY_DELAY_MS);
  }
  return false;
}

async function postStillVisible(page, id) {
  try {
    return await page.locator('article[data-testid="tweet"] a[href*="/status/"]')
      .evaluateAll((links, target) => links.some(link => link.href.includes(`/status/${target}`)), id);
  } catch {
    return true;
  }
}

async function deletePost(page, article, id) {
  while (true) {
    try {
      if (!await postStillVisible(page, id)) return true;
      const menu = mode === 'reposts'
        ? article.locator('[data-testid="unretweet"]')
        : article.locator('[data-testid="caret"], button[aria-label*="More"], [aria-label="More"]');
      await clickAndPause(menu, mode === 'reposts' ? `repost button for ${id}` : `menu for ${id}`);

      let deleteItem;
      let deleteLookupAttempts = 0;
      while (!deleteItem) {
        try {
          deleteItem = await firstVisible(page.locator('[role="menuitem"]').filter({
            hasText: ACTION_PATTERN,
          }));
          if (deleteItem) break;
        } catch {
          // X may briefly remove the menu while redrawing it.
        }
        deleteLookupAttempts++;
        if (mode !== 'posts' && deleteLookupAttempts >= DELETE_LOOKUP_ATTEMPTS) {
          await page.keyboard.press('Escape').catch(() => {});
          console.log(`Skipping ${TARGET_LABEL} item ${id}; no removal action appeared.`);
          return false;
        }
        await sleep(STEP_RETRY_DELAY_MS);
        try {
          await page.keyboard.press('Escape').catch(() => {});
          await clickAndPause(menu, mode === 'reposts' ? `repost button for ${id}` : `menu for ${id}`);
        } catch {
          // clickAndPause owns its retry loop; keep this step alive if X redraws.
        }
      }
      await clickAndPause(deleteItem, `Delete action for ${id}`);

      if (mode !== 'reposts') {
        const confirm = page.locator(
          '[data-testid="confirmationSheetConfirm"], [role="dialog"] button',
        ).filter({hasText: /^\s*Delete\s*$/i});
        await clickAndPause(confirm, `Delete confirmation for ${id}`);
      }
      if (await waitForDeletion(page, id)) return true;
    } catch {
      // The complete delete sequence is retried below.
    }
    console.log(`${TARGET_LABEL} item ${id} is still present; waiting 1 second and trying the removal sequence again.`);
    await sleep(STEP_RETRY_DELAY_MS);
  }
}

async function findPage(browser, cdpUrl) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(page.url())) return page;
    }
  }
  throw new Error(`No X tab found. Start Chrome with remote debugging at ${cdpUrl} and open X first.`);
}

async function main() {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const page = await findPage(browser, cdpUrl);
  HANDLE = await discoverHandle(page);
  PROFILE_URL = profileUrl();
  console.log(`Using @${HANDLE}; target: ${TARGET_LABEL}`);

  await page.goto(PROFILE_URL, {waitUntil: 'domcontentloaded'});
  await sleep(RETRY_WAIT_MS);
  await selectTargetTab(page);

  const processed = new Set();
  let deleted = 0;
  let inspected = 0;
  let noNewPosts = 0;
  let lastDeletedAt = Date.now();

  while ((dryRun ? inspected : deleted) < limit) {
    try {
      if (await reloadAfterRetry(page)) {
      await selectTargetTab(page);
      lastDeletedAt = Date.now();
      noNewPosts = 0;
      continue;
      }
    if (!dryRun && Date.now() - lastDeletedAt >= STALL_RELOAD_MS) {
        await reloadPage(page, 'No confirmed deletion for 20 seconds; reloading the page.');
        await selectTargetTab(page);
        lastDeletedAt = Date.now();
        noNewPosts = 0;
        continue;
      }

      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();
      let candidate = null;
      let candidateId = '';
      for (let index = 0; index < count; index++) {
        const article = articles.nth(index);
        if (!(await visible(article))) continue;
        const id = await statusId(article);
        if (id && !processed.has(id)) {
          candidate = article;
          candidateId = id;
          break;
        }
      }

      if (!candidate) {
        const before = new Set();
        for (let index = 0; index < count; index++) {
          const id = await statusId(articles.nth(index));
          if (id) before.add(id);
        }
        await page.evaluate(() => window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.8))));
        await sleep(SCROLL_WAIT_MS);
        const after = await page.locator('article[data-testid="tweet"] a[href*="/status/"]')
          .evaluateAll(links => links.map(link => (link.href.match(/\/status\/(\d+)/) || [])[1]).filter(Boolean));
        if (after.some(id => !before.has(id))) {
          noNewPosts = 0;
        } else if (++noNewPosts >= MAX_NO_NEW_PASSES) {
          await reloadPage(
            page,
            `No new ${TARGET_LABEL} after ${MAX_NO_NEW_PASSES} incremental scrolls; reloading and continuing.`,
          );
          await selectTargetTab(page);
          noNewPosts = 0;
          lastDeletedAt = Date.now();
        }
        continue;
      }

      if (dryRun) {
        processed.add(candidateId);
        inspected++;
        console.log(`[dry-run] would delete https://x.com/${HANDLE}/status/${candidateId} (${TARGET_LABEL})`);
        continue;
      }

      try {
        const deletedPost = await deletePost(page, candidate, candidateId);
        if (!deletedPost) {
          processed.add(candidateId);
          inspected++;
          continue;
        }
        deleted++;
        processed.add(candidateId);
        lastDeletedAt = Date.now();
        noNewPosts = 0;
        console.log(`Deleted ${deleted}/${limit}: ${candidateId}`);
      } catch (error) {
        await diagnostic(page, `post-${candidateId}`, error);
        console.log(`Post ${candidateId} did not complete; waiting 1 second and trying again.`);
        await sleep(STEP_RETRY_DELAY_MS);
      }
    } catch (error) {
      await diagnostic(page, 'crawl-step', error);
      console.log(`Crawl step failed; waiting 1 second and trying again.`);
      await sleep(STEP_RETRY_DELAY_MS);
    }
  }

  console.log(`${dryRun ? 'Dry run found' : 'Confirmed deleted'} ${dryRun ? inspected : deleted} ${TARGET_LABEL}.`);
  await browser.close();
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

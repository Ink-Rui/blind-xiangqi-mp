/**
 * E2E 冒烟：设置页首屏 → 开始 AI 对局 → 走子 → 棋谱 → 悔棋 → 再走 → 认输 → 回放 → 返回设置看战绩
 * 用法：npm run e2e
 * 本地默认复用系统 Edge（Windows）；CI 用 `npx playwright install chromium` 后直接跑。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../docs/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = join(root, normalize(rel));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404).end('not found');
  }
});

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}

let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const channel = process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  // 排行榜在页面加载时就会拉取；E2E 不依赖外网，统一返回空榜
  await context.route('**/rest/v1/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '[]'
  }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#startBtn');

  // 1. 设置页首屏与战绩卡片
  const first = await page.evaluate(() => ({
    bottom: Math.round(document.querySelector('#startBtn').getBoundingClientRect().bottom),
    vh: innerHeight,
    scrollW: document.documentElement.scrollWidth,
    cells: document.querySelectorAll('#statsNums .stat').length
  }));
  check('手机首屏内可见开始按钮', first.bottom <= first.vh, first);
  check('无横向溢出', first.scrollW <= 390, first.scrollW);
  check('战绩卡片 5 项', first.cells === 5, first.cells);

  // 1.1 陪练难度与今日榜
  const extras = await page.evaluate(() => ({
    levels: document.querySelectorAll('#optLevel .opt').length,
    rankCard: !!document.querySelector('#rankCard'),
    rankNote: document.querySelector('#rankNote').textContent
  }));
  check('陪练难度 5 档', extras.levels === 5, extras.levels);
  check('今日榜卡片就绪', extras.rankCard, extras.rankCard);
  const rankReady = await page.waitForFunction(
    () => !document.querySelector('#rankList').textContent.includes('加载中'),
    null, { timeout: 5000 }
  ).then(() => true).catch(() => false);
  const rankText = await page.locator('#rankList').textContent();
  check('空榜有提示且无报错', rankReady && rankText.includes('还没有人上榜'), { rankReady, rankText });

  // 2. 开始 AI 对局
  await page.locator('#optPlay .opt', { hasText: 'AI 陪练' }).click();
  await page.locator('#startBtn').click();
  await page.waitForSelector('#gameView:not(.hidden)');
  const board = await page.evaluate(() => ({
    pieces: document.querySelectorAll('#pieces .piece').length,
    mode: document.querySelector('#modeChip').textContent,
    time: document.querySelector('#timeChip').textContent
  }));
  check('开局渲染 32 子', board.pieces === 32, board);
  check('模式与计时就绪', board.mode.includes('AI') && /^用时 \d+:\d{2}$/.test(board.time), board);

  // 3. 走子
  const moveOnce = () => page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const el of [...document.querySelectorAll('#pieces .piece')]) {
      el.click();
      await sleep(60);
      const t = document.querySelector('#hints .target');
      if (t) {
        t.click();
        await sleep(1300);
        return document.querySelector('#moveChip').textContent;
      }
      el.click();
      await sleep(30);
    }
    return null;
  });
  const moved = await moveOnce();
  const aiReplied = await page.waitForFunction(
    () => document.querySelector('#moveChip').textContent !== '第 2 手', null, { timeout: 5000 }
  ).then(() => true).catch(() => false);
  check('走子后 AI 应招', !!moved && moved !== '第 1 手' && aiReplied, { moved, aiReplied });

  // 4. 棋谱
  await page.locator('#logBtn').click();
  await page.waitForSelector('#modal:not(.hidden)');
  const logText = await page.locator('#modalBody').textContent();
  check('棋谱弹层包含记录', /对局记录/.test(logText) && /1\./.test(logText), logText.slice(0, 40));
  await page.locator('#modalCancel').click();

  // 5. 悔棋（AI 模式一次退两步，回到开局）
  await page.locator('#undoBtn').click();
  await page.waitForTimeout(350);
  const afterUndo = await page.locator('#moveChip').textContent();
  check('悔棋回到第 1 手', afterUndo === '第 1 手', afterUndo);

  // 6. 再走一手后认输，验证结束面板与战绩入库
  await moveOnce();
  await page.locator('#resignBtn').click();
  await page.waitForSelector('#modal:not(.hidden)');
  await page.locator('#modalOk').click();
  await page.waitForSelector('#endOverlay:not(.hidden)');
  const end = await page.evaluate(() => ({
    title: document.querySelector('#endTitle').textContent,
    stats: document.querySelector('#endStats').textContent,
    saved: JSON.parse(localStorage.getItem('blind-xiangqi-stats') || 'null')
  }));
  check('结束面板显示用时与累计', end.stats.includes('本局用时') && end.stats.includes('累计'), end.stats);
  check('战绩写入本地', !!(end.saved && end.saved.games >= 1 && end.saved.losses >= 1), end.saved && end.saved.games);

  // 7. 回放
  await page.locator('#replayBtn').click();
  await page.waitForSelector('#replayBar:not(.hidden)');
  const rev = await page.evaluate(() => ({
    label: document.querySelector('#revLabel').textContent,
    pieces: document.querySelectorAll('#pieces .piece').length
  }));
  check('回放可打开且棋盘完整', rev.label.startsWith('0/') && rev.pieces === 32, rev);
  await page.locator('#revExit').click();
  await page.waitForFunction(() => document.querySelector('#replayBar').classList.contains('hidden'));
  check('退出回放恢复终局', await page.locator('#endOverlay:not(.hidden)').count() === 1);

  // 8. 返回设置页
  await page.locator('#toSetupBtn').click();
  await page.waitForSelector('#setupView:not(.hidden)');
  const nums = await page.locator('#statsNums .stat b').allTextContents();
  check('设置页展示战绩', nums[0] !== '0', nums);

  // 9. 今日一局：终局面板展示排行榜并禁用悔棋
  await page.locator('#dailyBtn').click();
  await page.waitForSelector('#gameView:not(.hidden)');
  await page.locator('#resignBtn').click();
  await page.waitForSelector('#modal:not(.hidden)');
  await page.locator('#modalOk').click();
  await page.waitForSelector('#endRank:not(.hidden)');
  await page.waitForFunction(
    () => document.querySelector('#endRankNote').textContent.includes('今日榜'),
    null, { timeout: 5000 }
  ).catch(() => {});
  const daily = await page.evaluate(() => ({
    note: document.querySelector('#endRankNote').textContent,
    undo: document.querySelector('#undoBtn').disabled,
    mode: document.querySelector('#modeChip').textContent
  }));
  check('今日一局终局展示排行榜', daily.note.includes('今日榜') && daily.mode.includes('今日一局'), daily);
  check('今日一局禁用悔棋', daily.undo === true, daily.undo);

  check('无 JS 异常', errors.length === 0, errors.slice(0, 3));
} catch (e) {
  failed++;
  console.error('E2E ERROR', e);
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}

console.log('\nE2E 失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

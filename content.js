// 同人小说自动续读
// 章节页形如：/tongren/10218/65.html -> 第 65 章
//
// 功能：
//   1. 自动抓取后续章节（章数可在扩展设置里改），拼接在当前页面下方
//   2. 保留站点原来的标题、正文排版，不自己造样式
//   3. 读到一定进度后删除上方旧章节，并继续补足后面的章节
//   4. 弱网自动重试；成功内容写入 localStorage，下次打开直接用缓存
(() => {
  'use strict';

  if (window.__acrReader) return;
  window.__acrReader = true;

  const m = location.pathname.match(/^\/([^/]+)\/(\d+)\/(\d+)\.html$/);
  if (!m) return;

  const bookKey = `${m[1]}-${m[2]}`;
  const basePath = `/${m[1]}/${m[2]}/`;
  const startNum = parseInt(m[3], 10);
  if (!Number.isFinite(startNum)) return;

  const MAX_ATTEMPTS = 5;        // 单章单轮最多尝试次数
  const FETCH_TIMEOUT = 12000;
  const RETRY_WAIT = 6000;
  const STORE_KEY = `acr:${bookKey}`;
  const ENABLED_KEY = 'acr:enabled';

  const cfg = { batch: 10, lowWater: 3, keepAbove: 2 };

  const $doc = document;

  let enabled = localStorage.getItem(ENABLED_KEY) !== '0';
  let root = null;
  let contentEl = null;
  let sections = [];
  let currentNum = startNum;
  let lastCutNum = -Infinity;
  let workerRunning = false;
  let atEnd = false;
  let lastErrorNum = 0;
  let panel = null;
  let panelText = null;
  let retryBtn = null;
  let retryTimer = 0;

  const cache = readCache();

  // ---------- 工具 ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cnCount(s) {
    return (String(s || '').match(/[\u4e00-\u9fff]/g) || []).length;
  }

  function isTyping(el) {
    return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  function saveCache() {
    try {
      const nums = Object.keys(cache).map(Number).sort((a, b) => a - b);
      while (nums.length > 60) delete cache[nums.shift()];
      localStorage.setItem(STORE_KEY, JSON.stringify(cache));
    } catch {
      try {
        const nums = Object.keys(cache).map(Number).sort((a, b) => a - b);
        nums.slice(0, Math.ceil(nums.length / 2)).forEach((n) => delete cache[n]);
        localStorage.setItem(STORE_KEY, JSON.stringify(cache));
      } catch {}
    }
  }

  async function loadSettings() {
    try {
      const s = await chrome.storage.sync.get({ batch: 10, lowWater: 3, ahead: 10, keepAbove: 2 });
      const batchRaw = s.batch !== undefined && Number.isFinite(parseInt(s.batch, 10)) ? s.batch : s.ahead;
      cfg.batch = Math.min(50, Math.max(1, parseInt(batchRaw, 10) || 10));
      cfg.lowWater = Math.min(20, Math.max(1, parseInt(s.lowWater, 10) || 3));
      cfg.keepAbove = Math.min(20, Math.max(0, parseInt(s.keepAbove, 10) || 0));
    } catch {}
  }

  function decodeBuffer(buf) {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if ((utf8.match(/\uFFFD/g) || []).length < 5) return utf8;
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return utf8;
    }
  }

  // ---------- 正文 / 标题识别 ----------

  const CONTENT_SELECTORS = [
    '.read_chapterDetail',
    '#content',
    '#chaptercontent',
    '#booktxt',
    '#nr1',
    '#txtContent',
    '.read-content',
    '.chapter-content',
    '.article-content',
    '.showtxt',
    '.content',
    '.txt',
    'article'
  ];

  function pickContent(scope) {
    for (const sel of CONTENT_SELECTORS) {
      const el = scope.querySelector(sel);
      if (el && cnCount(el.textContent) > 250) return el;
    }
    let best = null;
    let bestScore = 0;
    for (const el of scope.querySelectorAll('div,article,section,td')) {
      const n = cnCount(el.textContent);
      if (n < 300) continue;
      const linkChars = Array.from(el.querySelectorAll('a')).reduce((a, x) => a + cnCount(x.textContent), 0);
      const brs = el.querySelectorAll('br').length;
      const score = n + brs * 8 - linkChars * 2;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    while (best) {
      const limit = cnCount(best.textContent) * 0.9;
      let deeper = null;
      for (const child of best.children) {
        if (cnCount(child.textContent) >= limit) {
          deeper = child;
          break;
        }
      }
      if (!deeper) break;
      best = deeper;
    }
    return best;
  }

  function sanitizeOuter(el, isBody) {
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,noscript,iframe,ins,.ad,.ads,.advert').forEach((n) => n.remove());
    c.querySelectorAll('a[href^="javascript:"]').forEach((a) => a.removeAttribute('href'));
    [c, ...c.querySelectorAll('*')].forEach((n) => {
      for (const attr of Array.from(n.attributes || [])) {
        if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
      }
    });
    if (isBody) {
      c.querySelectorAll('p,div,span').forEach((n) => {
        const t = (n.textContent || '').trim();
        if (t && t.length < 40 && /本章未完|请收藏|手机版阅读|加入书签|投推荐票/.test(t)) n.remove();
      });
    }
    return c.outerHTML;
  }

  function normalizeTitle(raw, num) {
    let t = String(raw || '')
      .replace(/\s+/g, ' ')
      .replace(/^(最新章节[:：]?)/, '')
      .trim();
    t = t.split(/[_\|｜]/)[0].trim();
    // “书名 第66章”这种把书名去掉，标题只留章节号
    const tail = t.match(/^(.*?)[\s　]*(第\s*[\d一二三四五六七八九十百千零两]+\s*章)[\s　]*$/);
    if (tail && tail[1]) t = tail[2];
    if (!t || t.length > 80) t = '';
    const hasNum = /第\s*[\d一二三四五六七八九十百千零两]+\s*章/.test(t);
    if (t && !hasNum) t = `第${num}章 ${t}`;
    if (!t) t = `第${num}章`;
    return t;
  }

  function titleFromDoc(doc, num) {
    const el =
      doc.querySelector('.read_chapterName h1') ||
      doc.querySelector('.bookname h1') ||
      doc.querySelector('.title h1') ||
      doc.querySelector('article h1') ||
      doc.querySelector('#title') ||
      doc.querySelector('h1');
    return normalizeTitle(el ? el.textContent : doc.title, num);
  }

  // ---------- 章节抓取 ----------

  function captureFromDoc(scope, num, title, url) {
    const bodyEl = pickContent(scope);
    if (!bodyEl) return null;
    const body = sanitizeOuter(bodyEl, true);
    if (cnCount(body) < 150) return null;
    const headEl = scope.querySelector('.read_chapterName');
    return {
      num,
      title,
      head: headEl ? sanitizeOuter(headEl, false) : '',
      body,
      url,
      t: Date.now()
    };
  }

  async function fetchChapter(num) {
    const url = `${basePath}${num}.html`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, credentials: 'same-origin', cache: 'no-store' });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = decodeBuffer(await res.arrayBuffer());
    if (cnCount(text) < 100) throw new Error('响应为空');
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const title = titleFromDoc(doc, num);
    const data = captureFromDoc(doc, num, title, url);
    if (!data) throw new Error('正文解析失败');
    return data;
  }

  async function fetchChapterWithRetry(num) {
    let lastErr = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (!enabled) break;
      try {
        const data = await fetchChapter(num);
        if (data === null) {
          atEnd = true;
          return null;
        }
        lastErrorNum = 0;
        return data;
      } catch (e) {
        lastErr = e;
        lastErrorNum = num;
        updatePanel();
        await sleep(800 + i * 1200);
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  // ---------- 渲染 ----------

  function fallbackHead(title) {
    return `<div class="read_chapterName tc"><h1>${escapeHtml(title)}</h1></div>`;
  }

  function mount(chapter) {
    if (sections.some((s) => s.num === chapter.num)) return;
    const sec = $doc.createElement('section');
    sec.className = 'acr-sec';
    sec.dataset.num = String(chapter.num);

    const head = chapter.head || fallbackHead(chapter.title || `第${chapter.num}章`);
    const body = chapter.body || `<div class="read_chapterDetail">${chapter.html || ''}</div>`;
    sec.innerHTML = head + body;

    root.append(sec);
    sections.push({ num: chapter.num, el: sec });
    updatePanel();
  }

  function setupReader(liveChapter) {
    const parent = contentEl.parentElement || $doc.body;

    root = $doc.createElement('div');
    root.id = 'acr-root';
    root.style.overflowAnchor = 'none';
    parent.insertBefore(root, contentEl);

    const headEl = $doc.querySelector('.read_chapterName');
    if (headEl) headEl.style.display = 'none';

    for (const sel of ['.pageNav', '.next_pre', '.hotlist']) {
      const n = $doc.querySelector(sel);
      if (n) n.style.display = 'none';
    }

    contentEl.style.display = 'none';

    cache[startNum] = liveChapter;
    mount(liveChapter);
    saveCache();
    updatePanel();
  }

  // ---------- 滚动 / 清理 / 补章 ----------

  function pickCurrent() {
    const probe = Math.max(120, window.innerHeight * 0.35);
    let cur = sections.length ? sections[0].num : startNum;
    for (const s of sections) {
      if (s.el.getBoundingClientRect().top <= probe) cur = s.num;
    }
    return cur;
  }

  function prune(cur) {
    const cutoff = cur - cfg.keepAbove;
    if (cutoff <= lastCutNum) return;
    const anchor = sections.find((s) => s.num === cur) || sections[sections.length - 1];
    const beforeTop = anchor ? anchor.el.getBoundingClientRect().top : 0;
    let removed = 0;
    while (sections.length && sections[0].num < cutoff) {
      const s = sections.shift();
      s.el.remove();
      removed++;
    }
    lastCutNum = cutoff;
    if (removed && anchor && anchor.el.isConnected) {
      const delta = anchor.el.getBoundingClientRect().top - beforeTop;
      if (delta) window.scrollBy(0, delta);
    }
  }

  function onScroll() {
    const cur = pickCurrent();
    if (cur !== currentNum) {
      currentNum = cur;
      prune(cur);
      try {
        history.replaceState(null, '', `${basePath}${cur}.html`);
      } catch {}
      const ch = cache[cur];
      if (ch) document.title = `${ch.title}_全本同人小说`;
      updatePanel();
    }
    ensureAhead();
  }

  // ---------- 后台预取 ----------

  // 已备未读章节剩 cfg.lowWater 时，才去抓下一批 cfg.batch 章
  const BATCH_PARALLEL = 3;

  function lastMountedNum() {
    return sections.length ? sections[sections.length - 1].num : startNum;
  }

  function mountCachedFrom(num) {
    let n = num;
    while (cache[n]) {
      mount(cache[n]);
      n++;
    }
    return n - 1;
  }

  async function fetchBatch(nums) {
    let cursor = 0;
    let stop = false;
    const pick = () => {
      while (cursor < nums.length) {
        const num = nums[cursor++];
        if (!cache[num]) return num;
      }
      return 0;
    };
    const workers = Array.from({ length: Math.min(BATCH_PARALLEL, nums.length) }, async () => {
      while (!stop && enabled) {
        const num = pick();
        if (!num) return;
        let data = null;
        try {
          data = await fetchChapterWithRetry(num);
        } catch {
          stop = true;
          return;
        }
        if (!data) {
          if (!enabled) return;
          atEnd = true;
          stop = true;
          return;
        }
        cache[data.num] = data;
        saveCache();
      }
    });
    await Promise.all(workers);
  }

  // 攒一批再抓；断网时从第一个没抓到的章开始，不回头重抓
  async function ensureAhead() {
    if (workerRunning || !enabled || atEnd) return;
    workerRunning = true;
    try {
      const mounted = mountCachedFrom(lastMountedNum() + 1);
      updatePanel();
      // 已备好还没读到的章还有 lowWater 个以上，就先不抓
      if (mounted - currentNum > cfg.lowWater) return;

      const first = mounted + 1;
      const nums = [];
      for (let i = 0; i < cfg.batch; i++) nums.push(first + i);

      await fetchBatch(nums);
      mountCachedFrom(first);
    } finally {
      workerRunning = false;
      updatePanel();
      if (!atEnd && lastErrorNum && enabled) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (enabled && !atEnd) ensureAhead();
        }, RETRY_WAIT);
      }
    }
  }

  // ---------- UI ----------

  function ensurePanel() {
    if (panel) return;

    const style = $doc.createElement('style');
    style.textContent = `
      #acr-dock{position:fixed;right:0;bottom:16px;z-index:2147483647;display:flex;align-items:center}
      #acr-panel{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px 0 0 10px;
        background:rgba(24,24,24,.88);color:#f2f2f2;
        font:12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
        box-shadow:0 6px 20px rgba(0,0,0,.3);white-space:nowrap;
        transform:translateX(calc(100% + 34px));transition:transform .28s ease}
      #acr-dock:hover #acr-panel,#acr-panel:focus-within{transform:translateX(0)}
      #acr-handle{writing-mode:vertical-rl;letter-spacing:3px;padding:11px 5px;border-radius:10px 0 0 10px;
        background:rgba(24,24,24,.88);color:#e8e8e8;cursor:default;user-select:none;
        font:12px/1.1 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
        box-shadow:0 6px 20px rgba(0,0,0,.3);opacity:.62;transition:opacity .2s}
      #acr-dock:hover #acr-handle{opacity:1}
    `;
    ($doc.head || $doc.documentElement).append(style);

    const dock = $doc.createElement('div');
    dock.id = 'acr-dock';

    panel = $doc.createElement('div');
    panel.id = 'acr-panel';

    panelText = $doc.createElement('span');
    panelText.textContent = '自动续读';

    const toggle = $doc.createElement('button');
    toggle.textContent = '暂停';
    toggle.style.cssText =
      'cursor:pointer;border:1px solid rgba(255,255,255,.28);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;font:inherit';
    toggle.addEventListener('click', () => {
      enabled = !enabled;
      toggle.textContent = enabled ? '暂停' : '继续';
      localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
      updatePanel();
      if (enabled) ensureAhead();
    });

    retryBtn = $doc.createElement('button');
    retryBtn.textContent = '重试';
    retryBtn.style.cssText =
      'cursor:pointer;border:1px solid rgba(255,255,255,.28);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;font:inherit;display:none';
    retryBtn.addEventListener('click', () => {
      lastErrorNum = 0;
      updatePanel();
      ensureAhead();
    });

    const cfgBtn = $doc.createElement('button');
    cfgBtn.textContent = '设置';
    cfgBtn.style.cssText = toggle.style.cssText;
    cfgBtn.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'acr:options' });
      } catch {}
    });

    panel.append(panelText, toggle, retryBtn, cfgBtn);

    const handle = $doc.createElement('div');
    handle.id = 'acr-handle';
    handle.textContent = '续读';
    handle.title = '自动续读';

    dock.append(panel, handle);
    ($doc.body || $doc.documentElement).append(dock);
    updatePanel();
  }

  function updatePanel() {
    if (!panelText) return;
    const last = sections.length ? sections[sections.length - 1].num : startNum;
    let txt = `${enabled ? '自动续读' : '已暂停'} · 读至 ${currentNum} · 已备至 ${last} · 余 ${Math.max(0, last - currentNum)}`;
    if (atEnd) txt += ' · 已到最后一章';
    else if (workerRunning) txt += ' · 补章中';
    if (lastErrorNum) txt += ` · 第${lastErrorNum}章重试中`;
    panelText.textContent = txt;
    if (retryBtn) retryBtn.style.display = lastErrorNum ? 'inline-block' : 'none';
  }

  // ---------- 启动 ----------

  function waitForContent() {
    return new Promise((resolve) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        const el = pickContent($doc);
        if (el) {
          clearInterval(timer);
          resolve(el);
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          resolve(null);
        }
      }, 400);
    });
  }

  function bindKeys() {
    $doc.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'ArrowRight') return;
        if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
        if (isTyping(e.activeElement)) return;
        if (!sections.length) return;

        const next = sections.find((s) => s.num === currentNum + 1);
        if (next) {
          e.preventDefault();
          next.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          e.preventDefault();
          ensureAhead();
          const t = setInterval(() => {
            const n2 = sections.find((s) => s.num === currentNum + 1);
            if (n2) {
              clearInterval(t);
              n2.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }, 500);
          setTimeout(() => clearInterval(t), 15000);
        }
      },
      true
    );
  }

  async function main() {
    await loadSettings();

    const el = await waitForContent();
    if (!el) {
      ensurePanel();
      panelText.textContent = '自动续读 · 未识别到正文';
      return;
    }
    contentEl = el;

    const title = titleFromDoc($doc, startNum);
    const live = captureFromDoc($doc, startNum, title, location.href);
    if (!live) {
      ensurePanel();
      panelText.textContent = '自动续读 · 正文为空';
      return;
    }

    setupReader(live);
    ensurePanel();
    bindKeys();

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.batch || changes.ahead) {
          const v = changes.batch ? changes.batch.newValue : changes.ahead.newValue;
          cfg.batch = Math.min(50, Math.max(1, parseInt(v, 10) || 10));
        }
        if (changes.lowWater) cfg.lowWater = Math.min(20, Math.max(1, parseInt(changes.lowWater.newValue, 10) || 3));
        if (changes.keepAbove) cfg.keepAbove = Math.min(20, Math.max(0, parseInt(changes.keepAbove.newValue, 10) || 0));
        prune(currentNum);
        updatePanel();
        ensureAhead();
      });
    } catch {}

    let ticking = false;
    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          onScroll();
        });
      },
      { passive: true }
    );

    if (enabled) ensureAhead();
  }

  if ($doc.readyState === 'loading') {
    $doc.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();

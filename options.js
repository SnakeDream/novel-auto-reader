const $ = (id) => document.getElementById(id);

const DEFAULTS = { batch: 10, lowWater: 3, keepAbove: 2 };

function clamp(n, min, max, fallback) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function normalizeSite(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/^\*:\/\/(\*\.)?[^/]+\/\*$/.test(s)) return s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname;
  if (!host || !host.includes('.') || /\s/.test(host)) return null;
  return `*://${host}/*`;
}

function renderSites(sites) {
  const box = $('siteList');
  box.textContent = '';
  if (!sites.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '还没有添加额外站点';
    box.append(p);
    return;
  }
  for (const site of sites) {
    const row = document.createElement('div');
    row.className = 'site-item';
    const code = document.createElement('code');
    code.textContent = site;
    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.textContent = '删除';
    btn.addEventListener('click', async () => {
      const { extraSites = [] } = await chrome.storage.sync.get('extraSites');
      const next = extraSites.filter((x) => x !== site);
      await chrome.storage.sync.set({ extraSites: next });
      chrome.permissions.remove({ origins: [site] }).catch(() => {});
      renderSites(next);
      $('siteStatus').textContent = '已删除，刷新目标页面后生效';
    });
    row.append(code, btn);
    box.append(row);
  }
}

async function load() {
  const s = await chrome.storage.sync.get({
    batch: DEFAULTS.batch,
    lowWater: DEFAULTS.lowWater,
    ahead: DEFAULTS.batch,
    keepAbove: DEFAULTS.keepAbove,
    extraSites: []
  });
  const batch = Number.isFinite(parseInt(s.batch, 10)) ? s.batch : s.ahead;
  $('batch').value = clamp(batch, 1, 50, DEFAULTS.batch);
  $('lowWater').value = clamp(s.lowWater, 1, 20, DEFAULTS.lowWater);
  $('keepAbove').value = clamp(s.keepAbove, 0, 20, DEFAULTS.keepAbove);
  renderSites(Array.isArray(s.extraSites) ? s.extraSites : []);
}

$('save').addEventListener('click', async () => {
  const batch = clamp($('batch').value, 1, 50, DEFAULTS.batch);
  const lowWater = clamp($('lowWater').value, 1, 20, DEFAULTS.lowWater);
  const keepAbove = clamp($('keepAbove').value, 0, 20, DEFAULTS.keepAbove);
  $('batch').value = batch;
  $('lowWater').value = lowWater;
  $('keepAbove').value = keepAbove;
  await chrome.storage.sync.set({ batch, lowWater, keepAbove });
  const st = $('saveStatus');
  st.textContent = '已保存，正在阅读的章节页会实时生效';
  setTimeout(() => {
    st.textContent = '';
  }, 4000);
});

const BUILTIN_HOSTS = ['qbtr.org', 'www.qbtr.org', 'qbtr.cc', 'www.qbtr.cc', 'bqquge.org', 'www.bqquge.org'];

$('addSite').addEventListener('click', async () => {
  const pattern = normalizeSite($('siteInput').value);
  const st = $('siteStatus');
  if (!pattern) {
    st.textContent = '网址格式不对，例如 qbtr.net 或 https://www.qbtr.net';
    return;
  }
  const host = pattern.replace(/^\*:\/\//, '').replace(/\/\*$/, '');
  if (BUILTIN_HOSTS.includes(host)) {
    st.textContent = '这个站点已经内置了，直接打开就能用';
    return;
  }

  // 权限请求必须紧跟用户点击，放在最前面
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch {
    granted = false;
  }
  if (!granted) {
    st.textContent = '没有授权该站点，添加取消';
    return;
  }

  const { extraSites = [] } = await chrome.storage.sync.get('extraSites');
  if (extraSites.includes(pattern)) {
    st.textContent = '这个站点已经在列表里了';
    return;
  }
  const next = [...extraSites, pattern];
  await chrome.storage.sync.set({ extraSites: next });
  renderSites(next);
  $('siteInput').value = '';
  try {
    await chrome.runtime.sendMessage({ type: 'acr:sync' });
  } catch {}
  st.textContent = '已添加，刷新目标站点页面后生效';
});

load();

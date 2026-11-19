// 给用户自己添加的站点注册 content script
const ID = 'acr-extra-sites';

async function getExtraSites() {
  try {
    const { extraSites } = await chrome.storage.sync.get({ extraSites: [] });
    return Array.isArray(extraSites) ? extraSites.filter((s) => typeof s === 'string' && s.includes('://')) : [];
  } catch {
    return [];
  }
}

async function syncExtraSites() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [ID] });
  } catch {}

  const sites = await getExtraSites();
  if (!sites.length) return;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: ID,
        matches: sites,
        js: ['content.js'],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true
      }
    ]);
  } catch (e) {
    console.warn('[自动续读] 注册站点失败', e);
  }
}

chrome.runtime.onInstalled.addListener(() => syncExtraSites());
chrome.runtime.onStartup.addListener(() => syncExtraSites());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.extraSites) syncExtraSites();
});

// 打开设置页时也能顺手同步一次
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'acr:options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'acr:sync') {
    syncExtraSites().then(() => sendResponse({ ok: true }));
    return true;
  }
});

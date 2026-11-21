/* =========================================================
   家庭药箱 - 核心逻辑
   数据全部存储在本地 IndexedDB，不上传任何服务器
   ========================================================= */

'use strict';

/* ---------- 常量与工具 ---------- */
const DB_NAME = 'family-medicine-box';
const DB_VERSION = 1;
const STORE_NAME = 'medicines';
const SETTINGS_KEY = 'mb_settings';

const $ = (id) => document.getElementById(id);
const DAY_MS = 24 * 60 * 60 * 1000;

// 到期状态计算
// 返回 { level: 'expired'|'soon'|'normal', days: number, text: string }
function getExpiryStatus(expiryStr, warnDays = 15) {
  if (!expiryStr) return { level: 'normal', days: Infinity, text: '' };
  // 有效期当天结束为 23:59:59
  const expiry = new Date(expiryStr + 'T23:59:59');
  const now = new Date();
  const diffMs = expiry - now;
  const days = Math.ceil(diffMs / DAY_MS);
  if (days < 0) return { level: 'expired', days, text: `已过期 ${Math.abs(days)} 天` };
  if (days === 0) return { level: 'expired', days, text: '今天过期' };
  if (days <= warnDays) return { level: 'soon', days, text: `剩 ${days} 天` };
  return { level: 'normal', days, text: `剩 ${days} 天` };
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

let toastTimer = null;
function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

/* ---------- IndexedDB ---------- */
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('expiry', 'expiry', { unique: false });
        store.createIndex('name', 'name', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllMedicines() {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const items = await reqDone(store.getAll());
  return items;
}

async function getMedicine(id) {
  const tx = db.transaction(STORE_NAME, 'readonly');
  return await reqDone(tx.objectStore(STORE_NAME).get(id));
}

async function saveMedicine(item) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(item);
  await txDone(tx);
  return item;
}

async function deleteMedicine(id) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(id);
  await txDone(tx);
}

/* ---------- 设置 ---------- */
function getSettings() {
  try {
    return Object.assign({ reminderEnabled: true, warnDays: 15 }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch { return { reminderEnabled: true, warnDays: 15 }; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

/* ---------- 图片处理 ---------- */
// 压缩图片：最长边限制在 maxSize，输出 jpeg blob
async function compressImage(file, maxSize = 1200, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  let targetW = width, targetH = height;
  if (width > height) {
    if (width > maxSize) { targetH = Math.round(height * maxSize / width); targetW = maxSize; }
  } else {
    if (height > maxSize) { targetW = Math.round(width * maxSize / height); targetH = maxSize; }
  }
  const canvas = document.createElement('canvas');
  canvas.width = targetW; canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close && bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return blob;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ---------- 应用状态 ---------- */
const state = {
  all: [],
  filter: 'all',
  keyword: '',
  editingId: null,
  tempPhotoBlob: null,      // 表单中临时照片
  tempPhotoChanged: false,  // 照片是否被改动
  detailId: null
};

/* ---------- 渲染列表 ---------- */
function render() {
  const settings = getSettings();
  const warnDays = settings.warnDays;

  // 统计
  let soon = 0, expired = 0;
  state.all.forEach((m) => {
    const s = getExpiryStatus(m.expiry, warnDays);
    if (s.level === 'soon') soon++;
    if (s.level === 'expired') expired++;
  });
  $('statTotal').textContent = state.all.length;
  $('statSoon').textContent = soon;
  $('statExpired').textContent = expired;

  // 过滤
  const kw = state.keyword.trim().toLowerCase();
  const filtered = state.all.filter((m) => {
    if (kw && !(`${m.name} ${m.category || ''} ${m.note || ''}`).toLowerCase().includes(kw)) return false;
    const s = getExpiryStatus(m.expiry, warnDays);
    if (state.filter === 'normal' && s.level !== 'normal') return false;
    if (state.filter === 'soon' && s.level !== 'soon') return false;
    if (state.filter === 'expired' && s.level !== 'expired') return false;
    return true;
  });

  // 按有效期升序排序（过期/临期在前）
  filtered.sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));

  const list = $('medicineList');
  const empty = $('emptyState');

  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
    const hasAny = state.all.length > 0;
    empty.querySelector('h3').textContent = hasAny ? '没有符合条件的药品' : '药箱还是空的';
    empty.querySelector('p').textContent = hasAny ? '试试换个关键词或筛选条件' : '点击右下角按钮，拍下第一盒药吧';
    return;
  }
  empty.hidden = true;

  const statusTextMap = { normal: '正常', soon: '临期', expired: '已过期' };
  list.innerHTML = filtered.map((m, i) => {
    const s = getExpiryStatus(m.expiry, warnDays);
    const photoHtml = m.photo
      ? `<img class="med-photo" data-src="${m.id}" alt="${escapeHtml(m.name)}" />`
      : `<div class="med-photo-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`;
    return `
      <div class="med-card" data-id="${m.id}" style="animation-delay:${Math.min(i, 8) * 0.03}s">
        ${photoHtml}
        <div class="med-status-strip"><span class="status-badge ${s.level}">${statusTextMap[s.level]}</span></div>
        ${m.quantity > 1 ? `<div class="med-qty-badge">×${m.quantity}</div>` : ''}
        <div class="med-info">
          <div class="med-name">${escapeHtml(m.name)}</div>
          ${m.category ? `<div class="med-category">${escapeHtml(m.category)}</div>` : ''}
          <div class="med-expiry ${s.level}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            <span>${formatDate(m.expiry)} · ${s.text}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  // 异步加载照片
  list.querySelectorAll('.med-photo[data-src]').forEach(async (img) => {
    try {
      const item = await getMedicine(img.dataset.src);
      if (item && item.photo) img.src = await blobToDataURL(item.photo);
    } catch (e) { /* ignore */ }
  });

  // 绑定卡片点击
  list.querySelectorAll('.med-card').forEach((card) => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
}

async function refresh() {
  state.all = await getAllMedicines();
  render();
}

/* ---------- 弹窗控制 ---------- */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

/* ---------- 表单：添加/编辑 ---------- */
function resetForm() {
  $('medicineForm').reset();
  state.editingId = null;
  state.tempPhotoBlob = null;
  state.tempPhotoChanged = false;
  $('formTitle').textContent = '添加药品';
  $('saveBtn').textContent = '保存';
  $('expiryInput').value = '';
  // 默认有效期设为一年后
  const d = new Date(); d.setFullYear(d.getFullYear() + 1);
  $('expiryInput').value = d.toISOString().slice(0, 10);
  $('quantityInput').value = 1;
  setCategory('常备药');
  updatePhotoPreview(null);
}

function setCategory(cat) {
  $('categoryInput').value = cat;
  document.querySelectorAll('#categoryChips .chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.cat === cat);
  });
}

function updatePhotoPreview(blobOrUrl) {
  const preview = $('photoPreview');
  if (blobOrUrl) {
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    preview.innerHTML = `<img src="${url}" alt="药品照片预览" />`;
    preview.classList.add('has-photo');
    $('removePhotoBtn').hidden = false;
  } else {
    preview.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span>点击添加药品照片</span>`;
    preview.classList.remove('has-photo');
    $('removePhotoBtn').hidden = true;
  }
}

async function openForm(id = null) {
  resetForm();
  if (id) {
    const item = await getMedicine(id);
    if (!item) return;
    state.editingId = id;
    $('formTitle').textContent = '编辑药品';
    $('saveBtn').textContent = '保存修改';
    $('nameInput').value = item.name;
    $('expiryInput').value = item.expiry;
    $('quantityInput').value = item.quantity || 1;
    $('noteInput').value = item.note || '';
    setCategory(item.category || '常备药');
    if (item.photo) {
      state.tempPhotoBlob = item.photo;
      updatePhotoPreview(await blobToDataURL(item.photo));
    }
  }
  openModal('formModal');
}

async function handlePhotoFile(file) {
  if (!file || !file.type.startsWith('image/')) { showToast('请选择图片文件'); return; }
  try {
    const blob = await compressImage(file);
    state.tempPhotoBlob = blob;
    state.tempPhotoChanged = true;
    updatePhotoPreview(blob);
  } catch (e) {
    showToast('图片处理失败，请重试');
  }
}

async function submitForm(e) {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  const expiry = $('expiryInput').value;
  if (!name) { showToast('请填写药品名称'); return; }
  if (!expiry) { showToast('请选择有效期'); return; }

  let photo = null;
  if (state.editingId) {
    const existing = await getMedicine(state.editingId);
    photo = state.tempPhotoChanged ? state.tempPhotoBlob : (existing ? existing.photo : null);
  } else {
    photo = state.tempPhotoBlob;
  }

  const item = {
    id: state.editingId || Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    expiry,
    category: $('categoryInput').value,
    quantity: parseInt($('quantityInput').value) || 1,
    note: $('noteInput').value.trim(),
    photo,
    updatedAt: new Date().toISOString()
  };

  try {
    await saveMedicine(item);
    closeModal('formModal');
    await refresh();
    showToast(state.editingId ? '已保存修改' : '添加成功');
  } catch (e) {
    showToast('保存失败，请重试');
  }
}

/* ---------- 详情弹窗 ---------- */
async function openDetail(id) {
  const item = await getMedicine(id);
  if (!item) return;
  state.detailId = id;
  const settings = getSettings();
  const s = getExpiryStatus(item.expiry, settings.warnDays);
  const statusTextMap = { normal: '正常', soon: '临期', expired: '已过期' };

  $('detailName').textContent = item.name;
  const badge = $('detailStatus');
  badge.textContent = statusTextMap[s.level];
  badge.className = 'status-badge ' + s.level;
  $('detailExpiry').textContent = formatDate(item.expiry);
  $('detailDays').textContent = s.text;
  $('detailQuantity').textContent = '× ' + (item.quantity || 1);
  $('detailCategory').textContent = item.category || '-';
  const updated = new Date(item.updatedAt);
  $('detailUpdated').textContent = `更新于 ${updated.getFullYear()}-${String(updated.getMonth()+1).padStart(2,'0')}-${String(updated.getDate()).padStart(2,'0')}`;

  if (item.note) {
    $('detailNoteWrap').hidden = false;
    $('detailNote').textContent = item.note;
  } else {
    $('detailNoteWrap').hidden = true;
  }

  const img = $('detailPhoto');
  const ph = $('detailPhotoPlaceholder');
  if (item.photo) {
    img.src = await blobToDataURL(item.photo);
    img.hidden = false; ph.hidden = true;
  } else {
    img.removeAttribute('src');
    img.hidden = true; ph.hidden = false;
  }
  openModal('detailModal');
}

/* ---------- 确认弹窗 ---------- */
let confirmCallback = null;
function showConfirm(title, message, okText, callback) {
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmOk').textContent = okText;
  confirmCallback = callback;
  openModal('confirmModal');
}

/* ---------- 到期提醒 ---------- */
async function checkReminders() {
  const settings = getSettings();
  if (!settings.reminderEnabled) return;
  const soonItems = state.all.filter((m) => {
    const s = getExpiryStatus(m.expiry, settings.warnDays);
    return s.level === 'expired' || s.level === 'soon';
  });
  if (soonItems.length === 0) return;

  // 通知权限已授予则推送
  if ('Notification' in window && Notification.permission === 'granted') {
    const expired = soonItems.filter((m) => getExpiryStatus(m.expiry, settings.warnDays).level === 'expired');
    const soon = soonItems.length - expired.length;
    let body = '';
    if (expired.length) body += `${expired.length} 种药品已过期`;
    if (soon.length) body += (body ? '；' : '') + `${soon.length} 种即将过期`;
    body += '，请及时查看处理。';
    try {
      const n = new Notification('家庭药箱提醒', {
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: 'medicine-reminder'
      });
      setTimeout(() => n.close(), 12000);
    } catch (e) { /* 部分环境不支持构造通知 */ }
  }
}

async function requestNotifyPermission() {
  if (!('Notification' in window)) {
    updateNotifyStatus('当前浏览器不支持通知');
    showToast('当前浏览器不支持通知');
    return;
  }
  const perm = await Notification.requestPermission();
  updateNotifyStatus(perm === 'granted' ? '已开启（推荐）' : (perm === 'denied' ? '已拒绝，请在浏览器设置中开启' : '未开启'));
  if (perm === 'granted') { showToast('通知已开启'); checkReminders(); }
}

function updateNotifyStatus(text) { $('notifyStatus').textContent = '通知状态：' + text; }

/* ---------- 导入导出 ---------- */
async function exportData() {
  const items = await getAllMedicines();
  // 将照片 blob 转为 dataURL 一起导出
  const data = [];
  for (const m of items) {
    const copy = { ...m };
    if (m.photo) copy.photo = await blobToDataURL(m.photo);
    data.push(copy);
  }
  const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), medicines: data }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `家庭药箱备份_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('备份文件已导出');
}

function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new Blob([u8arr], { type: mime });
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.medicines || !Array.isArray(data.medicines)) throw new Error('bad format');
    let count = 0;
    for (const m of data.medicines) {
      const item = { ...m };
      if (typeof item.photo === 'string' && item.photo.startsWith('data:')) {
        item.photo = dataURLtoBlob(item.photo);
      }
      if (!item.id) item.id = Date.now().toString(36) + Math.random().toString(36).slice(2,7);
      await saveMedicine(item);
      count++;
    }
    await refresh();
    showToast(`已导入 ${count} 条药品`);
  } catch (e) {
    showToast('导入失败，文件格式不正确');
  }
}

/* ---------- PWA 安装 ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').hidden = false;
});

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('addBtn').addEventListener('click', () => openForm());

  $('settingsBtn').addEventListener('click', () => openModal('settingsModal'));

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  $('medicineForm').addEventListener('submit', submitForm);

  // 拍照 / 选图
  $('photoPreview').addEventListener('click', () => $('photoInput').click());
  $('takePhotoBtn').addEventListener('click', () => {
    const input = $('photoInput');
    input.setAttribute('capture', 'environment');
    input.click();
    input.removeAttribute('capture');
  });
  $('choosePhotoBtn').addEventListener('click', () => $('photoInput').click());
  $('photoInput').addEventListener('change', (e) => {
    if (e.target.files[0]) handlePhotoFile(e.target.files[0]);
    e.target.value = '';
  });
  $('removePhotoBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    state.tempPhotoBlob = null;
    state.tempPhotoChanged = true;
    updatePhotoPreview(null);
  });

  // 分类 chips
  document.querySelectorAll('#categoryChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => setCategory(chip.dataset.cat));
  });

  // 搜索
  $('searchInput').addEventListener('input', (e) => {
    state.keyword = e.target.value;
    $('clearSearch').classList.toggle('show', !!e.target.value);
    render();
  });
  $('clearSearch').addEventListener('click', () => {
    $('searchInput').value = '';
    state.keyword = '';
    $('clearSearch').classList.remove('show');
    render();
  });

  // 筛选
  document.querySelectorAll('#filterTabs .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#filterTabs .filter-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.filter = tab.dataset.filter;
      render();
    });
  });

  // 详情操作
  $('editBtn').addEventListener('click', () => {
    const id = state.detailId;
    closeModal('detailModal');
    openForm(id);
  });
  $('deleteBtn').addEventListener('click', () => {
    const id = state.detailId;
    showConfirm('删除药品', '删除后将无法恢复，确定要删除这个药品吗？', '删除', async () => {
      await deleteMedicine(id);
      closeModal('detailModal');
      await refresh();
      showToast('已删除');
    });
  });

  // 确认弹窗
  $('confirmCancel').addEventListener('click', () => { closeModal('confirmModal'); confirmCallback = null; });
  $('confirmOk').addEventListener('click', async () => {
    closeModal('confirmModal');
    if (confirmCallback) { await confirmCallback(); confirmCallback = null; }
  });

  // 设置
  const settings = getSettings();
  $('reminderToggle').checked = settings.reminderEnabled;
  $('reminderDays').value = String(settings.warnDays);
  $('reminderToggle').addEventListener('change', (e) => {
    const s = getSettings(); s.reminderEnabled = e.target.checked; saveSettings(s);
    showToast(e.target.checked ? '已开启到期提醒' : '已关闭到期提醒');
  });
  $('reminderDays').addEventListener('change', (e) => {
    const s = getSettings(); s.warnDays = parseInt(e.target.value); saveSettings(s);
    render();
    showToast('提醒天数已更新');
  });
  $('requestNotifyBtn').addEventListener('click', requestNotifyPermission);

  // 安装
  $('installBtn').addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('installBtn').hidden = true;
    } else {
      $('installHint').hidden = false;
    }
  });

  // 导入导出
  $('exportBtn').addEventListener('click', exportData);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
}

/* ---------- 初始化 ---------- */
async function init() {
  try {
    await openDB();
    bindEvents();
    await refresh();

    // 通知状态
    if ('Notification' in window) {
      const p = Notification.permission;
      updateNotifyStatus(p === 'granted' ? '已开启（推荐）' : (p === 'denied' ? '已拒绝，请在浏览器设置中开启' : '未开启'));
    }

    // 延迟检查提醒
    setTimeout(checkReminders, 800);
  } catch (e) {
    console.error('初始化失败', e);
    showToast('初始化失败，请刷新重试');
  }
}

// 注册 Service Worker（离线缓存 + 可安装）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 注册失败', e));
  });
}

document.addEventListener('DOMContentLoaded', init);

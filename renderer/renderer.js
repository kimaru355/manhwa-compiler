'use strict';

const MAX_LOG_LINES = 5000;

const $ = (id) => document.getElementById(id);
const chooseBtn = $('choose');
const startBtn = $('start');
const cancelBtn = $('cancel');
const chaptersBox = $('chapters');
const completeBox = $('complete');
const skipBox = $('skip');
const modesEl = $('modes');
const folderEl = $('folder');
const listBox = $('listBox');
const listEl = $('list');
const listSummary = $('listSummary');
const fill = $('fill');
const statusEl = $('status');
const percentEl = $('percent');
const logEl = $('log');
const resultEl = $('result');
const resultText = $('resultText');
const revealBtn = $('reveal');

let items = []; // [{ folder, name, chapterCount, imageCount, checked }]
let revealPath = null;

const currentMode = () => document.querySelector('input[name="mode"]:checked').value;
const selectedItems = () => items.filter((i) => i.checked && i.imageCount > 0);

function addLog(text, level = 'info') {
  const line = document.createElement('div');
  line.className = level;
  line.textContent = text;
  const pinned = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();
  if (pinned) logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(done, total) {
  const pct = total ? Math.floor((done / total) * 100) : 0;
  fill.style.width = pct + '%';
  percentEl.textContent = pct + '%';
}

function updateSummary() {
  const sel = selectedItems();
  const images = sel.reduce((n, i) => n + i.imageCount, 0);
  listSummary.textContent = `${sel.length} of ${items.length} selected — ${images} images`;
  const hasOutput = chaptersBox.checked || completeBox.checked;
  startBtn.disabled = sel.length === 0 || !hasOutput;
  if (sel.length && !hasOutput) statusEl.textContent = 'Tick chapter PDFs and/or the complete PDF';
}

chaptersBox.addEventListener('change', updateSummary);
completeBox.addEventListener('change', updateSummary);

function renderList() {
  listEl.textContent = '';
  for (const item of items) {
    const row = document.createElement('label');
    row.className = 'item' + (item.imageCount === 0 ? ' empty' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.checked;
    box.disabled = item.imageCount === 0;
    box.addEventListener('change', () => { item.checked = box.checked; updateSummary(); });
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    name.title = item.folder;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = item.imageCount ? `${item.chapterCount} ch · ${item.imageCount} img` : 'no images';
    row.append(box, name, meta);
    listEl.appendChild(row);
  }
  listBox.hidden = false;
  updateSummary();
}

function setAll(checked) {
  for (const item of items) item.checked = checked && item.imageCount > 0;
  renderList();
}

function setBusy(busy) {
  chooseBtn.disabled = busy;
  chaptersBox.disabled = busy;
  completeBox.disabled = busy;
  skipBox.disabled = busy;
  for (const r of modesEl.querySelectorAll('input')) r.disabled = busy;
  for (const b of listEl.querySelectorAll('input')) b.disabled = busy || b.disabled;
  startBtn.hidden = busy;
  cancelBtn.hidden = !busy;
  cancelBtn.disabled = false;
  if (!busy) renderList();
}

function showResult(kind, text, canReveal) {
  resultEl.hidden = false;
  resultEl.className = 'result' + (kind ? ' ' + kind : '');
  resultText.textContent = text;
  revealBtn.hidden = !canReveal;
}

window.api.onProgress((data) => {
  if (data.text) addLog(data.text, data.level);
  if (data.status) statusEl.textContent = data.status;
  if (data.total !== undefined) setProgress(data.done, data.total);
});

modesEl.addEventListener('change', () => {
  items = [];
  listBox.hidden = true;
  startBtn.disabled = true;
  folderEl.textContent = 'Nothing chosen';
  folderEl.classList.add('muted');
  statusEl.textContent = 'Idle';
});

chooseBtn.addEventListener('click', async () => {
  const mode = currentMode();
  const picked = await window.api.chooseFolders(mode);
  if (!picked) return;
  items = picked.items.map((i) => ({ ...i, checked: i.imageCount > 0 }));
  const label = picked.root || (items.length === 1 ? items[0].folder : `${items.length} folders chosen`);
  folderEl.textContent = label;
  folderEl.title = label;
  folderEl.classList.remove('muted');
  resultEl.hidden = true;
  fill.className = '';
  setProgress(0, 0);
  renderList();
  statusEl.textContent = items.some((i) => i.imageCount > 0)
    ? 'Ready'
    : mode === 'library' ? 'No manhwa folders found in this folder' : 'No images found';
});

$('selAll').addEventListener('click', (e) => { e.preventDefault(); setAll(true); });
$('selNone').addEventListener('click', (e) => { e.preventDefault(); setAll(false); });

startBtn.addEventListener('click', async () => {
  const sel = selectedItems();
  if (!sel.length) return;
  logEl.textContent = '';
  resultEl.hidden = true;
  fill.className = '';
  setProgress(0, 1);
  statusEl.textContent = 'Starting...';
  setBusy(true);

  const res = await window.api.start({
    folders: sel.map((i) => i.folder),
    buildChapters: chaptersBox.checked,
    buildComplete: completeBox.checked,
    skipExisting: skipBox.checked,
  });

  setBusy(false);
  if (!res.ok) {
    fill.className = 'failed';
    statusEl.textContent = 'Failed';
    addLog(`Error: ${res.error}`, 'error');
    showResult('error', `Failed: ${res.error}`, false);
    return;
  }

  const built = res.results.filter((r) => r.ok);
  const failed = res.results.filter((r) => r.ok === false);
  const skipped = res.results.filter((r) => r.skipped);
  const pages = built.reduce((n, r) => n + r.pages, 0);
  revealPath = built.length ? built[0].outputPath : null;

  const parts = [`${built.length} built (${pages} pages)`];
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  if (failed.length) parts.push(`${failed.length} failed`);
  const summary = parts.join(', ');

  if (res.cancelled) {
    fill.className = 'failed';
    statusEl.textContent = 'Cancelled';
    addLog(`Cancelled. The unfinished PDF was removed. ${summary}.`, 'warn');
    showResult('cancelled', `Cancelled. ${summary}.`, !!revealPath);
  } else {
    setProgress(1, 1);
    fill.className = failed.length ? 'failed' : 'done';
    statusEl.textContent = 'Done';
    for (const r of built) addLog(`Saved: ${r.outputPath}`);
    for (const r of failed) addLog(`Failed: ${r.name} - ${r.error}`, 'error');
    addLog(`Done. ${summary}.`);
    showResult(failed.length ? 'error' : '', `Done! ${summary}.`, !!revealPath);
  }
});

cancelBtn.addEventListener('click', () => {
  cancelBtn.disabled = true;
  statusEl.textContent = 'Cancelling...';
  window.api.cancel();
});

revealBtn.addEventListener('click', () => {
  if (revealPath) window.api.reveal(revealPath);
});

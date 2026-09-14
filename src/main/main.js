'use strict';
/*
 * ZENIT — main process / главный процесс.
 *  app://zenit/…                 — application files (window, libraries, star catalog);
 *  app://tiles/<layer>/<z>/<x>/<y> — base map tiles with a disk cache in %APPDATA%\ZENIT\tiles (works offline).
 */
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { makeZip } = require('./zip');

const ROOT = path.join(__dirname, '..', '..');
const CATALOG_DIR = app.isPackaged ? path.join(process.resourcesPath, 'catalog') : path.join(ROOT, 'catalog');
const UA = `ZENIT/${app.getVersion()} (Windows desktop; zenith passage calculator)`;

/** Источники подложек. {s} — поддомен, {z}/{x}/{y} — тайл. */
const PROVIDERS = {
  esri_img: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', ext: 'jpg' },
  esri_labels: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', ext: 'png' },
  esri_roads: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', ext: 'png' },
  esri_topo: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', ext: 'jpg' },
  otm: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', sub: ['a', 'b', 'c'], ext: 'png' },
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', ext: 'png' },
  carto_dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', sub: ['a', 'b', 'c', 'd'], ext: 'png' },
  carto_labels: { url: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png', sub: ['a', 'b', 'c', 'd'], ext: 'png' },
};

const DEFAULT_SETTINGS = { offline: false, dut1: 0, tz: 'local' };
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const tileDir = path.join(app.getPath('userData'), 'tiles');
let settings = {};
loadSettings();

/**
 * Language: saved setting → language chosen in the installer (resources/install-lang.txt, NSIS LCID) → English.
 * Язык: сохранённая настройка → выбор в установщике → английский.
 */
{
  let installLcid = null;
  try { installLcid = fs.readFileSync(path.join(process.resourcesPath, 'install-lang.txt'), 'utf8').trim(); } catch { /* portable or dev */ }
  let changed = false;
  // a new installer choice (first install or reinstall with another language) wins over the saved setting
  if (installLcid && installLcid !== settings.installLcid) {
    settings.lang = installLcid === '1049' ? 'ru' : 'en';
    settings.installLcid = installLcid;
    changed = true;
  }
  if (process.env.ZENIT_LANG && ['en', 'ru'].includes(process.env.ZENIT_LANG)) { settings.lang = process.env.ZENIT_LANG; changed = true; }
  if (!settings.lang) { settings.lang = 'en'; changed = true; }
  if (changed) { try { saveSettings(); } catch { /* read-only profile */ } }
}
app.commandLine.appendSwitch('lang', settings.lang === 'ru' ? 'ru-RU' : 'en-GB'); // en-GB: 24-hour date/time inputs

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function serveFile(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return new Response('not found', { status: 404 });
    const r = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers({ 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': String(st.size) });
    return new Response(r.body, { status: 200, headers });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

const inflight = new Map();
let subIdx = 0;

async function serveTile(parts) {
  const [layer, z, x, y] = parts;
  const prov = PROVIDERS[layer];
  if (!prov || ![z, x, y].every(v => /^\d+$/.test(v))) return new Response('bad tile', { status: 400 });
  const file = path.join(tileDir, layer, z, x, `${y}.${prov.ext}`);
  const ctype = prov.ext === 'jpg' ? 'image/jpeg' : 'image/png';
  try {
    const data = await fsp.readFile(file);
    return new Response(data, { headers: { 'content-type': ctype, 'x-cache': 'hit' } });
  } catch { /* нет в кэше */ }
  if (settings.offline) return new Response('offline', { status: 504 });

  const key = file;
  if (!inflight.has(key)) {
    const s = prov.sub ? prov.sub[subIdx++ % prov.sub.length] : '';
    const url = prov.url.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
    inflight.set(key, (async () => {
      const r = await net.fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, buf);
      return buf;
    })().finally(() => inflight.delete(key)));
  }
  try {
    const buf = await inflight.get(key);
    return new Response(buf, { headers: { 'content-type': ctype, 'x-cache': 'miss' } });
  } catch (e) {
    return new Response(String(e.message), { status: e.status || 502 });
  }
}

async function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { bytes += (await fsp.stat(p)).size; files++; } catch { /* файл исчез */ } }
    }
  };
  await walk(dir);
  return { bytes, files };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 980, minHeight: 640,
    backgroundColor: '#07090f', title: settings.lang === 'ru' ? 'ЗЕНИТ' : 'ZENIT',
    icon: path.join(ROOT, 'build', 'icon.png'),
    show: !process.argv.includes('--offscreen'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false,
      offscreen: process.argv.includes('--offscreen') }, // --offscreen: debug screenshots without a display
  });
  if (process.argv.includes('--offscreen')) { win.webContents.setFrameRate(30); win.setContentSize(1500, 880); }
  win.loadURL('app://zenit/src/renderer/index.html');
  // внешние ссылки (сайты, почта, телефон) — в системных программах, окно приложения никуда не уходит
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto|tel):/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('app://zenit/')) return;
    e.preventDefault();
    if (/^(https?|mailto|tel):/.test(url)) shell.openExternal(url);
  });
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
  // отладка: --log — консоль окна в stdout; --shot=файл.png[:сек] — снимок окна; --eval=файл.js — выполнить скрипт в окне
  if (process.argv.includes('--log')) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  }
  const shot = process.argv.find(a => a.startsWith('--shot='));
  const evalArg = process.argv.find(a => a.startsWith('--eval='));
  if (shot || evalArg) {
    win.webContents.once('did-finish-load', async () => {
      if (evalArg) {
        try {
          const code = fs.readFileSync(evalArg.slice(7), 'utf8');
          const res = await win.webContents.executeJavaScript(code, true);
          console.log('[eval] ' + JSON.stringify(res));
        } catch (err) { console.log('[eval error] ' + err.message); }
      }
      if (shot) {
        const m = /^--shot=(.+?)(?::(\d+))?$/.exec(shot);
        if (!evalArg) await new Promise(r => setTimeout(r, (+(m[2] || 8)) * 1000));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(m[1], img.toPNG());
        console.log('[shot] ' + m[1]);
      }
      if (process.argv.includes('--quit')) app.quit();
    });
  }
  return win;
}

app.whenReady().then(() => {

  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean);
    if (u.host === 'tiles') return serveTile(parts);
    if (u.host !== 'zenit' || parts.includes('..')) return new Response('forbidden', { status: 403 });
    if (parts[0] === 'catalog') return serveFile(path.join(CATALOG_DIR, ...parts.slice(1)));
    if (parts[0] === 'src' || parts[0] === 'node_modules' || parts[0] === 'build') return serveFile(path.join(ROOT, ...parts));
    return new Response('forbidden', { status: 403 });
  });

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => { settings = { ...settings, ...patch }; saveSettings(); return settings; });
  ipcMain.on('settings:lang-sync', (e) => { e.returnValue = settings.lang; });
  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('cache:stats', () => dirSize(tileDir));
  ipcMain.handle('cache:clear', async () => { await fsp.rm(tileDir, { recursive: true, force: true }); return dirSize(tileDir); });
  ipcMain.handle('cache:open', () => { fs.mkdirSync(tileDir, { recursive: true }); return shell.openPath(tileDir); });
  ipcMain.handle('file:save', async (e, { title, defaultName, filters, content, bom }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { title, defaultPath: path.join(app.getPath('documents'), defaultName), filters });
    if (r.canceled || !r.filePath) return null;
    if (/\.kmz$/i.test(r.filePath)) await fsp.writeFile(r.filePath, makeZip([['doc.kml', Buffer.from(content, 'utf8')]]));
    else await fsp.writeFile(r.filePath, (bom ? '﻿' : '') + content, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), userData: app.getPath('userData'), catalogDir: CATALOG_DIR }));

  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());

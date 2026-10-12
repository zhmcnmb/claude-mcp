const { app, BrowserWindow, ipcMain, dialog, clipboard, Tray, Menu, nativeImage } = require('electron');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { validateSettings } = require('./settings.cjs');
const { startServer } = require('../dist/service.cjs');

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  if (!process.env.CLAUDE_LOCAL_TEST_DIR) throw new Error('自检需要独立的 CLAUDE_LOCAL_TEST_DIR。');
  app.setPath('userData', process.env.CLAUDE_LOCAL_TEST_DIR);
}
if (!selfTest && !process.argv.includes('--server') && !app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  if (process.argv.includes('--server')) {
    require('../dist/server.cjs');
    return;
  }
  const configFile = path.join(app.getPath('userData'), 'settings.json');
  let state = { workspace: '', url: 'http://127.0.0.1:8765/sse', status: 'stopped', logs: [] };
  try {
    const saved = JSON.parse(await readFile(configFile, 'utf8'));
    if (typeof saved.workspace === 'string') state.workspace = saved.workspace;
    if (typeof saved.url === 'string') state.url = saved.url;
  } catch (error) {
    if (error.code !== 'ENOENT') state.logs.push(`读取设置失败：${error.message}`);
    else if (!selfTest) {
      try {
        const previous = JSON.parse(await readFile(path.join(os.homedir(), '.claude-local/workspace.json'), 'utf8'));
        if (typeof previous.workspace === 'string') state.workspace = previous.workspace;
      } catch (legacyError) {
        if (legacyError.code !== 'ENOENT') state.logs.push(`读取旧版工作区失败：${legacyError.message}`);
      }
    }
  }
  let service;
  let quitting = false;
  const window = new BrowserWindow({
    width: 860, height: 720, minWidth: 640, minHeight: 600,
    title: 'Claude Local MCP', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#f5f6f8', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const pageUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pageUrl) event.preventDefault(); });
  const publish = () => { if (!window.isDestroyed()) window.webContents.send('state', state); };
  const log = (message) => {
    state.logs = [...state.logs, String(message).slice(-8000)].slice(-100);
    publish();
  };
  const showWindow = () => {
    if (app.dock) app.dock.show().catch((error) => log(error.message));
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  const tray = new Tray(trayIcon);
  const trayMenu = Menu.buildFromTemplate([
    { id: 'show', label: '显示窗口', click: showWindow },
    { type: 'separator' },
    { id: 'quit', label: '退出程序', click: () => app.quit() },
  ]);
  tray.setToolTip('Claude Local MCP');
  tray.setContextMenu(trayMenu);
  tray.on('double-click', showWindow);
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.webContents.send('close-requested');
  });
  async function stop() {
    if (state.status !== 'running') return;
    state.status = 'stopping'; publish();
    try { await service.stop(); }
    finally { service = undefined; state.status = 'stopped'; publish(); }
    log('服务已停止。');
  }
  const handle = (name, handler) => ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的窗口请求。');
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) { log(error.message); return { ok: false, error: error.message }; }
  });
  handle('get-state', () => state);
  handle('choose-workspace', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择工作区', defaultPath: state.workspace || undefined, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('start', async (input) => {
    if (state.status !== 'stopped') throw new Error('请先停止当前服务，再修改设置。');
    state.status = 'starting'; publish();
    try {
      const settings = await validateSettings(input);
      service = await startServer({ ...settings, onLog: log });
      await mkdir(path.dirname(configFile), { recursive: true });
      await writeFile(configFile, JSON.stringify({ workspace: settings.workspace, url: settings.url }, null, 2) + '\n', 'utf8');
      state.workspace = settings.workspace; state.url = service.url; state.status = 'running'; publish();
      log(`服务已启动：${service.url}`);
      return state;
    } catch (error) {
      if (service) await service.stop();
      service = undefined; state.status = 'stopped'; publish();
      throw error;
    }
  });
  handle('stop', stop);
  handle('copy-url', async () => { await clipboard.writeText(state.url); });
  handle('close-action', (action) => {
    if (action === 'hide') { window.hide(); if (app.dock) app.dock.hide(); }
    else if (action === 'quit') app.quit();
    else throw new Error('无效的关闭操作。');
  });
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (state.status === 'starting' || state.status === 'stopping') {
      setTimeout(() => app.quit(), 100);
      return;
    }
    stop().catch((error) => log(error.message)).finally(() => { quitting = true; app.quit(); });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => tray.destroy());
  await window.loadURL(pageUrl);
  if (selfTest) {
    try {
      await require('./smoke-test.cjs')({ window, configFile, tray, trayMenu, onReadyToQuit: () => writeFile(path.join(process.env.CLAUDE_LOCAL_TEST_DIR, 'result.json'), JSON.stringify({ passed: true, exit: process.env.CLAUDE_LOCAL_TEST_EXIT }), 'utf8') });
      console.log('PASS：桌面界面自检通过');
    }
    catch (error) { console.error(error); await stop().catch(() => {}); app.exit(1); }
  }
}).catch((error) => { console.error(error); app.exit(1); });

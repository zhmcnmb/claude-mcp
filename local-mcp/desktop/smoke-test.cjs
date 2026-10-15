const assert = require('node:assert/strict');
const { mkdir, readFile, lstat } = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { clipboard } = require('electron');

module.exports = async ({ window, configFile, tray, trayMenu, onReadyToQuit }) => {
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    const deadline = Date.now() + 10000;
    while (!await evaluate(code)) {
      if (Date.now() > deadline) throw new Error(`界面等待超时：${code}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await waitFor('!document.getElementById("start").disabled');
  try {
    const previous = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(await evaluate('document.getElementById("workspace").value'), previous.workspace);
    assert.equal(await evaluate('document.getElementById("url").value'), previous.url);
    assert.equal(await evaluate('document.getElementById("shellPath").value'), previous.shellPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(await evaluate('typeof require'), 'undefined', 'renderer cannot access Node');
  assert.equal(await evaluate('typeof window.desktop.start'), 'function', 'sandbox preload is connected');
  const workspace = path.join(process.env.CLAUDE_LOCAL_TEST_DIR, 'project 中文');
  await mkdir(workspace, { recursive: true });
  const input = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`);
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await input('workspace', '');
  await click('start');
  await waitFor('!document.getElementById("error").hidden');
  assert.match(await evaluate('document.getElementById("error").textContent'), /选择工作区/);
  await input('workspace', workspace);
  await input('url', 'https://127.0.0.1:8765/sse');
  await click('start');
  await waitFor('!document.getElementById("error").hidden');
  assert.match(await evaluate('document.getElementById("error").textContent'), /HTTP/);
  await input('url', 'http://127.example.com:8765/sse');
  await click('start');
  await waitFor('!document.getElementById("error").hidden');
  assert.match(await evaluate('document.getElementById("error").textContent'), /本机地址/);

  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  const url = `http://127.0.0.1:${port}/custom-mcp`;
  try {
    await input('url', url);
    await click('start');
    await waitFor('!document.getElementById("error").hidden');
    assert.match(await evaluate('document.getElementById("error").textContent'), /已被占用/);
  } finally { await new Promise((resolve) => occupied.close(resolve)); }

  await input('shellPath', path.join(workspace, 'missing-shell.exe'));
  await click('start');
  await waitFor('!document.getElementById("error").hidden');
  assert.match(await evaluate('document.getElementById("error").textContent'), /找不到可执行文件/);
  const alias = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe');
  const shellPath = process.platform === 'win32' ? (alias && await lstat(alias).catch(() => null) ? alias : 'powershell.exe') : '/bin/sh';
  await input('shellPath', shellPath);
  await input('rgPath', path.join(workspace, 'missing-rg.exe'));
  await click('start');
  await waitFor('!document.getElementById("error").hidden');
  assert.match(await evaluate('document.getElementById("error").textContent'), /找不到可执行文件/);
  await input('rgPath', '');
  await click('start');
  await waitFor('document.getElementById("status").textContent === "运行中"');
  assert.equal(await evaluate('document.getElementById("url").disabled'), true);
  await click('copy');
  await waitFor('document.getElementById("copy").textContent === "已复制"');
  assert.equal(await clipboard.readText(), url);
  assert.match(await evaluate('document.getElementById("environment").textContent'), /Shell:.*[\s\S]*ripgrep:/);
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.deepEqual(saved, { workspace, url, shellPath, rgPath: '' });
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: endpoint/);
  assert.equal(tray.isDestroyed(), false, 'native tray icon exists');
  window.close();
  await waitFor('document.getElementById("close-dialog").open');
  await click('close-cancel');
  assert.equal(window.isVisible(), true, 'cancel keeps the window open');
  window.close();
  await waitFor('document.getElementById("close-dialog").open');
  await click('close-hide');
  await waitFor('!document.getElementById("close-dialog").open');
  // IPC 与界面事件分别处理，等主进程完成隐藏后检查原生窗口状态。
  const hideDeadline = Date.now() + 5000;
  while (window.isVisible() && Date.now() < hideDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(window.isVisible(), false, 'close action hides to tray');
  const background = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(background.status, 200, 'service stays available while hidden');
  await background.body.cancel();
  trayMenu.getMenuItemById('show').click();
  assert.equal(window.isVisible(), true, 'tray menu restores the window');
  await click('stop');
  await waitFor('document.getElementById("status").textContent === "已停止"');
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
  await reader.cancel();
  await input('url', `http://127.0.0.1:${port}/changed-url`);
  await click('start');
  await waitFor('document.getElementById("status").textContent === "运行中"');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).url, `http://127.0.0.1:${port}/changed-url`);
  // 两次自检分别走关闭选择框和托盘退出，外层检查退出后端口已释放。
  await onReadyToQuit();
  if (process.env.CLAUDE_LOCAL_TEST_EXIT === 'dialog') {
    window.close();
    await waitFor('document.getElementById("close-dialog").open');
    await click('close-quit');
  } else {
    window.close();
    await waitFor('document.getElementById("close-dialog").open');
    await click('close-hide');
    trayMenu.getMenuItemById('quit').click();
  }
};

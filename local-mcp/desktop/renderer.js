const $ = (id) => document.getElementById(id);
let initialized = false;
let previousStatus;

function render(state) {
  const stopped = state.status === 'stopped';
  const running = state.status === 'running';
  if (!initialized || (running && previousStatus !== 'running')) {
    $('workspace').value = state.workspace;
    $('url').value = state.url;
    initialized = true;
  }
  previousStatus = state.status;
  $('status').textContent = { stopped: '已停止', starting: '正在启动…', running: '运行中', stopping: '正在停止…' }[state.status];
  $('status').className = running ? 'running' : '';
  for (const id of ['workspace', 'url', 'browse', 'start']) $(id).disabled = !stopped;
  $('stop').disabled = !running;
  $('copy').disabled = !running;
  $('connection-url').textContent = state.url;
  $('saved').textContent = running ? '设置已保存' : '修改设置后点击启动服务';
  $('logs').textContent = state.logs.join('\n') || '服务尚未启动。';
  $('logs').scrollTop = $('logs').scrollHeight;
}

async function action(request) {
  $('error').hidden = true;
  try {
    const result = await request();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
}

$('browse').addEventListener('click', async () => {
  const folder = await action(() => window.desktop.chooseWorkspace());
  if (folder) $('workspace').value = folder;
});
$('start').addEventListener('click', () => action(() => window.desktop.start({ workspace: $('workspace').value, url: $('url').value })));
$('stop').addEventListener('click', () => action(() => window.desktop.stop()));
$('copy').addEventListener('click', async () => {
  const result = await window.desktop.copyUrl();
  if (result.ok) { $('copy').textContent = '已复制'; setTimeout(() => { $('copy').textContent = '复制 URL'; }, 1500); }
  else { $('error').textContent = result.error; $('error').hidden = false; }
});
window.desktop.onState(render);
window.desktop.onCloseRequested(() => { if (!$('close-dialog').open) $('close-dialog').showModal(); });
$('close-cancel').addEventListener('click', () => $('close-dialog').close());
for (const [id, choice] of [['close-hide', 'hide'], ['close-quit', 'quit']]) {
  $(id).addEventListener('click', () => {
    $('close-dialog').close();
    action(() => window.desktop.closeAction(choice));
  });
}
action(() => window.desktop.getState()).then((state) => { if (state) render(state); });

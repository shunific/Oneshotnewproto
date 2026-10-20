const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function boot({ lock = true, packaged = false, failLoad = false, ready = true, env = {} } = {}) {
  const app = new EventEmitter();
  const windows = [];
  const children = [];
  const errors = [];
  const keyStores = [], keyChannels = [], deviceReads = [];
  const timers = new Map();
  let nextTimer = 0;
  let unregistered = 0;
  Object.assign(app, {
    isPackaged: packaged,
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => lock,
    getPath: () => '/temporary-test-user-data',
    whenReady: () => Promise.resolve(),
    quit() { this.emit('before-quit'); this.quitCalled = true; },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; windows.push(this); }
    maximize() {}
    show() { this.shown = true; }
    focus() { this.focused = true; }
    restore() { this.restored = true; }
    isMinimized() { return true; }
    isDestroyed() { return !!this.destroyed; }
    loadURL(url) { (this.urls ||= []).push(url); return failLoad ? Promise.reject(new Error('offline')) : Promise.resolve(); }
  }
  const electron = {
    app, BrowserWindow,
    dialog: { showErrorBox: (...args) => errors.push(args) },
    globalShortcut: { register() {}, unregisterAll() { unregistered++; } },
  };
  const fork = (serverPath, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.kills = (child.kills || 0) + 1; };
    child.options = options;
    children.push(child);
    if (ready) queueMicrotask(() => child.emit('message', { type: 'backend-ready', port: Number(options.env.PORT) }));
    return child;
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), {
    require: name => {
      if(name === 'electron')return electron;
      if(name === 'child_process')return {fork};
      if(name === './device-key-store.cjs')return {createDeviceKeyStore:options=>{const store={loadDeviceKey:async()=>{throw Error('Not part of lifecycle fixture.');}};keyStores.push({options,store});return store;}};
      if(name === './host-device-key-channel.cjs')return {createHostDeviceKeyChannel:options=>{const channel={options,closes:0,close:async()=>{channel.closes++;}};keyChannels.push(channel);return channel;}};
      if(name === './native-device-id.cjs')return {readNativeDeviceId:async file=>{deviceReads.push(file);return '55555555-5555-4555-8555-555555555555';}};
      return require(name);
    },
    __dirname: path.join(__dirname, '..'),
    process: { env, resourcesPath: '/test/resources', platform: 'darwin' },
    console: { log() {}, error() {} },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  await new Promise(resolve => setImmediate(resolve));
  return { app, windows, children, errors, timers, keyStores, keyChannels, deviceReads, get unregistered() { return unregistered; } };
}

test('second instance exits without starting backend or window', async () => {
  const state = await boot({ lock: false });
  assert.equal(state.app.quitCalled, true);
  assert.equal(state.children.length, 0);
  assert.equal(state.windows.length, 0);
});

test('renderer is isolated and a second launch restores existing window', async () => {
  const { app, windows, children } = await boot();
  assert.equal(children.length, 1);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  assert.equal(windows[0].urls[0], 'http://localhost:5173');
  app.emit('second-instance');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].restored, true);
  assert.equal(windows[0].focused, true);
});

test('final window closes backend on macOS and suppresses intentional shutdown errors', async () => {
  const state = await boot();
  state.windows[0].emit('closed');
  state.app.emit('window-all-closed');
  assert.equal(state.app.quitCalled, true);
  assert.equal(state.children[0].kills, 1);
  state.children[0].emit('exit', 1);
  assert.equal(state.errors.length, 0);
  assert.ok(state.unregistered > 0);
});

test('quit from app menu stops backend even with a window open', async () => {
  const { app, children } = await boot();
  app.quit(); app.quit();
  assert.equal(children[0].kills, 1);
});

test('unexpected backend failure is visible and quits instead of continuing against another server', async () => {
  const { app, children, errors } = await boot();
  children[0].stderr.emit('data', Buffer.from('test failure'));
  children[0].emit('exit', 1);
  assert.match(errors[0][1], /test failure/);
  assert.equal(app.quitCalled, true);
});

test('closing a window cancels pending packaged load retries', async () => {
  const state = await boot({ packaged: true, failLoad: true });
  assert.equal(state.timers.size, 1);
  state.windows[0].destroyed = true;
  state.windows[0].emit('closed');
  assert.equal(state.timers.size, 0);
});

test('packaged startup retries until server becomes available without forking another backend', async () => {
  const state = await boot({ packaged: true, failLoad: true });
  const window = state.windows[0];
  window.loadURL = () => Promise.resolve();
  const retry = [...state.timers.values()][0];
  state.timers.clear();
  retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.children.length, 1);
  assert.equal(state.timers.size, 0);
  assert.equal(state.errors.length, 0);
});

test('packaged startup failure exhausts retries and reports actionable failure', async () => {
  const state = await boot({ packaged: true, failLoad: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    const retry = [...state.timers.values()][0];
    assert.equal(typeof retry, 'function');
    state.timers.clear();
    retry();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(state.timers.size, 0);
  assert.equal(state.children.length, 1);
  assert.match(state.errors[0][1], /local server did not become available/);
});

test('window waits for owned child readiness and ignores unrelated readiness messages', async () => {
  const state = await boot({ ready: false, packaged: true });
  assert.deepEqual(Array.from(state.children[0].options.stdio), ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(state.windows.length, 0);
  state.app.emit('activate');
  state.children[0].emit('message', { type: 'backend-ready', port: 3002 });
  state.children[0].emit('message', { type: 'other', port: 3001 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.windows.length, 0);
  state.children[0].emit('message', { type: 'backend-ready', port: 3001 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.windows.length, 1);
  assert.equal(state.windows[0].urls[0], 'http://127.0.0.1:3001');
  assert.equal(new URL(state.windows[0].urls[0]).hostname, '127.0.0.1');
  assert.equal(Number(new URL(state.windows[0].urls[0]).port), Number(state.children[0].options.env.PORT));
  assert.equal(state.timers.size, 0);
});

test('occupied port exit cannot open a window on a foreign backend', async () => {
  const state = await boot({ ready: false, packaged: true });
  state.children[0].stderr.emit('data', Buffer.from('EADDRINUSE port 3001'));
  state.children[0].emit('exit', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.windows.length, 0);
  assert.equal(state.app.quitCalled, true);
  assert.equal(state.timers.size, 0);
  assert.match(state.errors[0][1], /EADDRINUSE/);
});

test('startup timeout kills owned backend and never opens a window', async () => {
  const state = await boot({ ready: false });
  assert.equal(state.timers.size, 1);
  [...state.timers.values()][0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.children[0].kills, 1);
  assert.equal(state.windows.length, 0);
  assert.equal(state.app.quitCalled, true);
  assert.equal(state.timers.size, 0);
  assert.match(state.errors[0][1], /30 seconds/);
});

test('startup process error rejects readiness and cleans owned process', async () => {
  const state = await boot({ ready: false });
  state.children[0].emit('error', new Error('spawn failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.windows.length, 0);
  assert.equal(state.app.quitCalled, true);
  assert.equal(state.children[0].kills, 1);
  assert.equal(state.timers.size, 0);
});

test('quit during startup cancels timeout and ignores late readiness', async () => {
  const state = await boot({ ready: false });
  state.app.quit();
  state.children[0].emit('message', { type: 'backend-ready', port: 3001 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.windows.length, 0);
  assert.equal(state.children[0].kills, 1);
  assert.equal(state.timers.size, 0);
  assert.equal(state.errors.length, 0);
});


test('isolated QA port is forwarded to owned backend and packaged renderer', async () => {
  const state = await boot({ packaged: true, env: { ONESHOT_QA_PORT: '31371' } });
  assert.equal(state.children[0].options.env.PORT, '31371');
  assert.equal(state.windows[0].urls[0], 'http://127.0.0.1:31371');
  assert.equal(state.errors.length, 0);
});

test('QA startup ignores a readiness message for the default port', async () => {
  const state = await boot({ packaged: true, ready: false, env: { ONESHOT_QA_PORT: '31371' } });
  state.children[0].emit('message', { type: 'backend-ready', port: 3001 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.windows.length, 0);
  state.children[0].emit('message', { type: 'backend-ready', port: 31371 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.windows[0].urls[0], 'http://127.0.0.1:31371');
});

test('invalid QA ports fail before spawning a backend or opening a window', async () => {
  for (const port of ['', '0', '-1', '65536', '3.5', '31371junk', ' 31371', 'Infinity']) {
    const state = await boot({ packaged: true, env: { ONESHOT_QA_PORT: port } });
    assert.equal(state.children.length, 0);
    assert.equal(state.windows.length, 0);
    assert.equal(state.app.quitCalled, true);
    assert.match(state.errors[0][1], /ONESHOT_QA_PORT/);
  }
});

test('main attaches private key access only to its owned fork and canonical persisted device identity',async()=>{
 const state=await boot();assert.equal(state.keyStores.length,1);assert.equal(state.keyChannels.length,1);
 assert.equal(state.keyStores[0].options.app,state.app);assert.equal(state.keyStores[0].options.rootPath,'/temporary-test-user-data/device-credentials');
 const channel=state.keyChannels[0];assert.equal(channel.options.child,state.children[0]);assert.equal(channel.options.store,state.keyStores[0].store);
 await channel.options.resolveDeviceId();assert.deepEqual(state.deviceReads,['/temporary-test-user-data/oneshot.db']);
 state.app.quit();assert.equal(channel.closes,1);assert.equal(state.children[0].kills,1);
});

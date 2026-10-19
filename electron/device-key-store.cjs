const nativeFs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CIPHERTEXT_BYTES = 16384;
const fail = code => Object.assign(new Error({
  DEVICE_KEY_INVALID: 'Device key details are invalid.',
  DEVICE_KEY_CONFLICT: 'A different device credential is already enrolled.',
  DEVICE_KEY_UNAVAILABLE: 'Secure device key storage is unavailable.',
  DEVICE_KEY_REENCRYPT_REQUIRED: 'Device key storage requires owner maintenance.',
}[code]), { code });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const isId = value => typeof value === 'string' && UUID.test(value);
const normalizeError = error => ['DEVICE_KEY_INVALID','DEVICE_KEY_CONFLICT','DEVICE_KEY_UNAVAILABLE','DEVICE_KEY_REENCRYPT_REQUIRED'].includes(error?.code) ? fail(error.code) : fail('DEVICE_KEY_UNAVAILABLE');

// Main-process host capability only. Nothing here registers renderer or public API access.
function createDeviceKeyStore({ app, safeStorage, rootPath, fs = nativeFs, platform = process.platform, processType = process.type } = {}) {
  if (!app || typeof app.isReady !== 'function' || !safeStorage || typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || path.resolve(rootPath) === path.parse(rootPath).root) throw fail('DEVICE_KEY_INVALID');
  const root = path.resolve(rootPath);
  const unixPermissions = platform !== 'win32';
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const noFollow = constants.O_NOFOLLOW || 0;

  async function secureStorage() {
    if (processType !== 'browser' || app.isReady() !== true || !['darwin','win32','linux'].includes(platform) ||
        typeof safeStorage.isAsyncEncryptionAvailable !== 'function' || await safeStorage.isAsyncEncryptionAvailable() !== true ||
        typeof safeStorage.encryptStringAsync !== 'function' || typeof safeStorage.decryptStringAsync !== 'function') throw fail('DEVICE_KEY_UNAVAILABLE');
    if (platform === 'linux' && (typeof safeStorage.isEncryptionAvailable !== 'function' || safeStorage.isEncryptionAvailable() !== true || !['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend?.()))) throw fail('DEVICE_KEY_UNAVAILABLE');
  }
  function privateMetadata(stat, directory = false) {
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() ||
        (unixPermissions && ((stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)))) throw fail('DEVICE_KEY_UNAVAILABLE');
    if (!directory && (stat.size < 1 || stat.size > MAX_CIPHERTEXT_BYTES)) throw fail('DEVICE_KEY_UNAVAILABLE');
  }
  async function parentsAreDirectories() {
    let current = path.parse(root).root;
    const pieces = path.relative(current, path.dirname(root)).split(path.sep).filter(Boolean);
    for (const piece of pieces) {
      current = path.join(current, piece);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('DEVICE_KEY_UNAVAILABLE');
    }
  }
  async function directory(create = false) {
    await parentsAreDirectories();
    if (create) {
      try { await fs.mkdir(root, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await fs.lstat(root);
    privateMetadata(stat, true);
    if (await fs.realpath(root) !== root) throw fail('DEVICE_KEY_UNAVAILABLE');
    return stat;
  }
  async function sameDirectory(expected) {
    const current = await directory();
    if (current.dev !== expected.dev || current.ino !== expected.ino) throw fail('DEVICE_KEY_UNAVAILABLE');
  }
  async function decode(ciphertext, deviceId) {
    const decrypted = await safeStorage.decryptStringAsync(ciphertext);
    if (!exactKeys(decrypted, ['result','shouldReEncrypt']) || typeof decrypted.result !== 'string' || typeof decrypted.shouldReEncrypt !== 'boolean') throw fail('DEVICE_KEY_UNAVAILABLE');
    if (decrypted.shouldReEncrypt) throw fail('DEVICE_KEY_REENCRYPT_REQUIRED');
    let value;
    try { value = JSON.parse(decrypted.result); } catch { throw fail('DEVICE_KEY_UNAVAILABLE'); }
    if (!exactKeys(value, ['version','deviceId','keyId','key']) || value.version !== 1 || !isId(value.deviceId) || value.deviceId !== deviceId || !isId(value.keyId) || typeof value.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.key)) throw fail('DEVICE_KEY_UNAVAILABLE');
    const key = Buffer.from(value.key, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value.key) { key.fill(0); throw fail('DEVICE_KEY_UNAVAILABLE'); }
    return { deviceId: value.deviceId, keyId: value.keyId, key };
  }
  async function read(deviceId, expectedDirectory) {
    await sameDirectory(expectedDirectory);
    const filename = path.join(root, `${deviceId}.key`);
    const initial = await fs.lstat(filename);
    privateMetadata(initial);
    let handle, ciphertext;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      privateMetadata(opened);
      if (opened.dev !== initial.dev || opened.ino !== initial.ino) throw fail('DEVICE_KEY_UNAVAILABLE');
      const bounded = Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead <= opened.size) {
        const chunk = await handle.read(bounded, bytesRead, opened.size + 1 - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      ciphertext = bounded.subarray(0, bytesRead);
      if (ciphertext.length !== opened.size) throw fail('DEVICE_KEY_UNAVAILABLE');
      await sameDirectory(expectedDirectory);
      const final = await fs.lstat(filename);
      privateMetadata(final);
      if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size) throw fail('DEVICE_KEY_UNAVAILABLE');
      const decoded = await decode(ciphertext, deviceId);
      try {
        await sameDirectory(expectedDirectory);
        const current = await fs.lstat(filename);
        privateMetadata(current);
        if (current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) throw fail('DEVICE_KEY_UNAVAILABLE');
        return decoded;
      } catch (error) { decoded.key.fill(0); throw error; }
    } finally {
      if (handle) await handle.close();
      if (ciphertext) ciphertext.fill(0);
    }
  }
  async function loadDeviceKey(deviceId) {
    try {
      if (!isId(deviceId)) throw fail('DEVICE_KEY_INVALID');
      await secureStorage();
      const credential = await read(deviceId, await directory());
      const key = credential.key;
      return Object.freeze({ ...credential, dispose: () => key.fill(0) });
    } catch (error) { throw normalizeError(error); }
  }
  async function provision(input) {
    let key, ciphertext, temporary, handle;
    try {
      if (!exactKeys(input, ['version','deviceId','keyId','key']) || input.version !== 1 || !isId(input.deviceId) || !isId(input.keyId) || !Buffer.isBuffer(input.key) || input.key.length !== 32) throw fail('DEVICE_KEY_INVALID');
      const { deviceId, keyId } = input;
      key = Buffer.from(input.key);
      await secureStorage();
      const rootStat = await directory(true);
      const matchExisting = async () => {
        let existing;
        try {
          existing = await read(deviceId, rootStat);
          if (existing.keyId !== keyId || !timingSafeEqual(existing.key, key)) throw fail('DEVICE_KEY_CONFLICT');
          return Object.freeze({ version: 1, deviceId, keyId, created: false });
        } finally { if (existing) existing.key.fill(0); }
      };
      try { return await matchExisting(); }
      catch (error) {
        // Only a genuinely absent leaf permits initial publication; corrupt or insecure keys stay untouched.
        if (error.code !== 'ENOENT') throw error;
      }
      ciphertext = await safeStorage.encryptStringAsync(JSON.stringify({ version: 1, deviceId, keyId, key: key.toString('base64') }));
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 1 || ciphertext.length > MAX_CIPHERTEXT_BYTES) throw fail('DEVICE_KEY_UNAVAILABLE');
      const verified = await decode(ciphertext, deviceId);
      try {
        if (verified.keyId !== keyId || !timingSafeEqual(verified.key, key)) throw fail('DEVICE_KEY_UNAVAILABLE');
      } finally { verified.key.fill(0); }
      await sameDirectory(rootStat);
      temporary = path.join(root, `.${deviceId}.${randomUUID()}.tmp`);
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      await handle.writeFile(ciphertext);
      await handle.sync();
      await handle.close(); handle = null;
      await sameDirectory(rootStat);
      try {
        // A hard-link publishes only complete fsynced ciphertext and cannot overwrite another enrollment.
        await fs.link(temporary, path.join(root, `${deviceId}.key`));
      } catch (error) {
        if (error.code === 'EEXIST') return await matchExisting();
        throw error;
      }
      await sameDirectory(rootStat);
      if (unixPermissions) {
        const directoryHandle = await fs.open(root, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | noFollow);
        try {
          const metadata = await directoryHandle.stat();
          if (metadata.dev !== rootStat.dev || metadata.ino !== rootStat.ino) throw fail('DEVICE_KEY_UNAVAILABLE');
          await directoryHandle.sync();
        } finally { await directoryHandle.close(); }
      }
      return Object.freeze({ version: 1, deviceId, keyId, created: true });
    } catch (error) { throw normalizeError(error); }
    finally {
      if (handle) await handle.close().catch(() => {});
      if (temporary) await fs.unlink(temporary).catch(() => {});
      if (key) key.fill(0);
      if (ciphertext) ciphertext.fill(0);
    }
  }
  return Object.freeze({ provision, loadDeviceKey });
}
module.exports = { createDeviceKeyStore };

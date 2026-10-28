'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runDefault = promisify(execFile);
const { jwkThumbprint } = require('./license-client.cjs');

const REGISTRY_ANCHOR = 'HKCU\\Software\\KennedCodeDisparos\\Licensing';
const WINDOWS_FINGERPRINT_NAMESPACE = 'kenned-code-disparos-device-v1';
const BOOT_IDENTITY_NAMESPACE = 'kenned-code-disparos-boot-v1';
const WINDOWS_BOOT_QUERY = "$boot=(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o'); $event=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-General';Id=12} -MaxEvents 1 -ErrorAction Stop; if($null -eq $event -or $event.RecordId -lt 1){throw 'Boot event unavailable'}; @{recordId=$event.RecordId.ToString();bootTime=$boot}|ConvertTo-Json -Compress";
function error(code, message) { return Object.assign(new Error(message), { code }); }
function atomicProtectedFile(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.tmp-' + crypto.randomUUID();
  try { const fd = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temporary, filename); fs.chmodSync(filename, 0o600); } finally { fs.rmSync(temporary, { force: true }); }
}
class LicenseIdentityHost {
  constructor({ safeStorage, platform = process.platform, directory, run = runDefault, readFile = filename => fs.readFileSync(filename, 'utf8') } = {}) {
    this.safeStorage = safeStorage; this.platform = platform; this.run = run; this.readFile = readFile;
    this.directory = directory || (platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'KennedCodeDisparos-Licensing') : path.join(os.homedir(), '.local', 'share', 'KennedCodeDisparos-Licensing-development'));
    this.loading = null; this.identity = null; this.saving = Promise.resolve();
  }
  async _run(executable, args) { return this.run(executable, args, { windowsHide: true, timeout: 12000, maxBuffer: 32768, encoding: 'utf8' }); }
  async _registryRead(name, root = REGISTRY_ANCHOR) {
    if (this.platform !== 'win32') return null;
    try { const result = await this._run('reg.exe', ['query', root, '/v', name, '/reg:64']); const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return result.stdout.match(new RegExp('^\\s*' + escaped + '\\s+REG_(?:SZ|BINARY)\\s+(.+)\\s*$', 'mi'))?.[1]?.trim() || null; } catch { return null; }
  }
  async _registryWrite(name, value) {
    if (this.platform !== 'win32') return;
    try { await this._run('reg.exe', ['add', REGISTRY_ANCHOR, '/v', name, '/t', 'REG_SZ', '/d', value, '/f', '/reg:64']); } catch { throw error('LICENSE_ANCHOR_UNAVAILABLE', 'O Windows não permitiu preservar a identidade da licença no registro. Verifique as permissões do usuário.'); }
  }
  _protect(value) {
    if (this.platform === 'win32') {
      if (!this.safeStorage?.isEncryptionAvailable()) throw error('LICENSE_PROTECTION_UNAVAILABLE', 'A proteção DPAPI do Windows não está disponível. A ativação foi bloqueada para proteger a identidade.');
      return this.safeStorage.encryptString(JSON.stringify(value));
    }
    // Development/test execution on Linux is explicitly separate from Windows
    // distribution: restrictive file permissions, never a free-license bypass.
    return Buffer.from(JSON.stringify(value));
  }
  _unprotect(bytes) {
    try { return JSON.parse(this.platform === 'win32' ? this.safeStorage.decryptString(Buffer.from(bytes)) : Buffer.from(bytes).toString('utf8')); } catch { throw error('LICENSE_PROTECTED_STATE_INVALID', 'Não foi possível abrir a identidade protegida. Restaure o arquivo original com o mesmo usuário do Windows.'); }
  }
  async _copies(name, filename) {
    const values = [];
    if (fs.existsSync(filename)) values.push(this._unprotect(fs.readFileSync(filename)));
    const registry = await this._registryRead(name);
    if (registry) values.push(this._unprotect(Buffer.from(registry, 'base64')));
    return values;
  }
  async _save(name, filename, value) {
    const bytes = this._protect(value);
    // Registry survives profile deletion/reinstallation; server remains the
    // authority if both anchors are deliberately removed.
    await this._registryWrite(name, Buffer.from(bytes).toString('base64'));
    atomicProtectedFile(filename, bytes);
  }
  async fingerprint() {
    let seed;
    if (this.platform === 'win32') {
      const machineGuid = await this._registryRead('MachineGuid', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography');
      let uuid = '';
      try { uuid = (await this._run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID'])).stdout.trim().toLowerCase(); } catch {}
      if (!/^[a-f0-9-]{32,38}$/i.test(machineGuid || '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(uuid) || /^f{8}-f{4}-f{4}-f{4}-f{12}$/.test(uuid)) throw error('LICENSE_DEVICE_UNAVAILABLE', 'Não foi possível obter a identificação estável do Windows e do hardware. Verifique o acesso a WMI/CIM e ao registro.');
      seed = WINDOWS_FINGERPRINT_NAMESPACE + '\n' + machineGuid.toLowerCase() + '\n' + uuid;
    } else {
      let machineId = '';
      try { machineId = this.readFile('/etc/machine-id').trim().toLowerCase(); } catch {}
      if (!/^[a-f0-9]{32}$/.test(machineId)) throw error('LICENSE_PLATFORM_UNSUPPORTED', 'A identificação deste ambiente de desenvolvimento não está disponível. A distribuição é destinada ao Windows.');
      seed = WINDOWS_FINGERPRINT_NAMESPACE + '\nlinux-development\n' + machineId;
    }
    return crypto.createHash('sha256').update(seed).digest('hex');
  }
  async bootIdentity() {
    // Uptime alone cannot identify a reboot: after enough time the new uptime
    // can exceed the checkpoint. Use an OS boot identifier independent of the
    // elapsed timer and preserve its hash inside the protected checkpoint.
    let seed;
    try {
      if (this.platform === 'win32') {
        const result = await this._run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOOT_QUERY]);
        const value = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
        if (!/^[1-9][0-9]{0,19}$/.test(value.recordId || '') || typeof value.bootTime !== 'string' || !Number.isFinite(Date.parse(value.bootTime)) || Date.parse(value.bootTime) <= 0) throw new Error('Invalid boot identity');
        seed = BOOT_IDENTITY_NAMESPACE + '\nwindows\n' + value.recordId + '\n' + new Date(value.bootTime).toISOString();
      } else if (this.platform === 'linux') {
        const value = this.readFile('/proc/sys/kernel/random/boot_id').trim().toLowerCase();
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) throw new Error('Invalid boot identity');
        seed = BOOT_IDENTITY_NAMESPACE + '\nlinux-development\n' + value;
      } else throw new Error('Unsupported platform');
    } catch {
      throw error('LICENSE_BOOT_IDENTITY_UNAVAILABLE', 'Não foi possível confirmar a inicialização do sistema operacional. Conecte à internet para validar a licença; o cache offline não será usado ao reabrir.');
    }
    return crypto.createHash('sha256').update(seed).digest('hex');
  }
  async load() {
    if (this.identity) return this.identity;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const deviceId = await this.fingerprint(), filename = path.join(this.directory, 'device.protected');
      const candidates = await this._copies('DeviceIdentityV1', filename);
      let identity = candidates[0];
      if (candidates.some(value => value.deviceId !== deviceId) || candidates.some(value => identity && jwkThumbprint(value.publicKeyJwk) !== jwkThumbprint(identity.publicKeyJwk))) throw error('LICENSE_IDENTITY_CONFLICT', 'A identidade protegida não corresponde a este dispositivo. Restaure a identidade original antes de ativar.');
      if (!identity) {
        const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        identity = { version: 1, deviceId, publicKeyJwk: pair.publicKey.export({ format: 'jwk' }), privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      }
      if (identity.version !== 1 || identity.deviceId !== deviceId || typeof identity.privateKeyPem !== 'string') throw error('LICENSE_IDENTITY_INVALID', 'A identidade protegida é inválida. Recupere a identidade original.');
      const actualPublic = crypto.createPublicKey(crypto.createPrivateKey(identity.privateKeyPem)).export({ format: 'jwk' });
      if (jwkThumbprint(actualPublic) !== jwkThumbprint(identity.publicKeyJwk)) throw error('LICENSE_IDENTITY_INVALID', 'A chave protegida não corresponde a este dispositivo.');
      await this._save('DeviceIdentityV1', filename, identity);
      this.identity = identity; return identity;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }
  async loadState() {
    await this.load();
    const states = await this._copies('LicenseStateV1', path.join(this.directory, 'state.protected'));
    if (!states.length) return null;
    // Prefer the furthest persisted trusted timestamp if one anchor is older.
    states.sort((a, b) => (b.anchor?.lastTrusted || 0) - (a.anchor?.lastTrusted || 0) || Number(!!b.authoritativeDenial) - Number(!!a.authoritativeDenial));
    return states[0];
  }
  async saveState(value) {
    const save = async () => this._save('LicenseStateV1', path.join(this.directory, 'state.protected'), value);
    const operation = this.saving.then(save, save); this.saving = operation.catch(() => {}); return operation;
  }
}

module.exports = { LicenseIdentityHost, WINDOWS_FINGERPRINT_NAMESPACE, REGISTRY_ANCHOR };

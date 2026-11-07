import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decrypt, deriveKey, detectTokenType, encrypt, loadAppSecret, maskToken } from '../server/secrets.js';
import { setup, OAUTH } from './helpers.js';

describe('secrets', () => {
  it('chiffre et déchiffre, et refuse une autre clé', () => {
    const k = deriveKey('s1', 'claude-token');
    const payload = encrypt(k, 'sk-ant-oat-xyz');
    expect(payload).not.toContain('xyz');
    expect(decrypt(k, payload)).toBe('sk-ant-oat-xyz');
    expect(() => decrypt(deriveKey('s2', 'claude-token'), payload)).toThrow();
  });

  it('détecte le type de token', () => {
    expect(detectTokenType('sk-ant-oat01-abc')).toBe('oauth');
    expect(detectTokenType('sk-ant-api03-abc')).toBe('api');
    expect(detectTokenType('abc')).toBeNull();
    expect(maskToken('sk-ant-oat01-abcdefgh1234')).toBe('sk-ant-oat…1234');
  });

  it('génère APP_SECRET une fois, en 600, puis le relit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronde-'));
    const a = loadAppSecret({ appSecret: null, dataDir: dir });
    const b = loadAppSecret({ appSecret: null, dataDir: dir });
    expect(a).toHaveLength(64);
    expect(b).toBe(a);
    expect(fs.statSync(path.join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(loadAppSecret({ appSecret: 'env', dataDir: dir })).toBe('env');
  });

  it('stocke le token chiffré ; la variable d’env est prioritaire', () => {
    const { store, claudeAuth } = setup();
    expect(store.getSetting('claude_token')).not.toContain(OAUTH.slice(-10));
    expect(claudeAuth.resolve()).toMatchObject({ token: OAUTH, type: 'oauth', source: 'db' });
    expect(() => claudeAuth.save('pas-un-token')).toThrow(/Format/);

    const env = setup({ envToken: 'sk-ant-api03-zzz', token: null });
    expect(env.claudeAuth.resolve()).toMatchObject({ type: 'api', source: 'env' });
  });
});

import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
export const PAGE_SIZE = 4096, RESERVE = 80;
export const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
export function normalizeKey(value) {
  const key = String(value || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('密钥必须是 64 位十六进制字符串');
  return Buffer.from(key, 'hex');
}
export function macKey(key, salt) { return pbkdf2Sync(key, Buffer.from(salt.map(x=>x^0x3a)), 2, 32, 'sha512'); }
export function pageHmac(page, pageNumber, key) {
  const number = Buffer.alloc(4); number.writeUInt32LE(pageNumber);
  return createHmac('sha512', key).update(page.subarray(pageNumber === 1 ? 16 : 0, PAGE_SIZE - 64)).update(number).digest();
}
export function verifyPage(page, pageNumber, key) {
  return page.length === PAGE_SIZE && timingSafeEqual(page.subarray(PAGE_SIZE - 64), pageHmac(page, pageNumber, key));
}
export function resolveKey(material, page) {
  if (page.length !== PAGE_SIZE) throw new Error('数据库首个页面不完整');
  const salt = page.subarray(0, 16);
  const direct = macKey(material, salt);
  if (verifyPage(page, 1, direct)) return { encryption: Buffer.from(material), mac: direct, mode: 'raw_enc_key' };
  direct.fill(0);
  const derived = pbkdf2Sync(material, salt, 256000, 32, 'sha512');
  const mac = macKey(derived, salt);
  if (verifyPage(page, 1, mac)) return { encryption: derived, mac, mode: 'sqlcipher_passphrase' };
  derived.fill(0); mac.fill(0);
  throw new Error('密钥与数据库不匹配（首个页面 HMAC 校验失败）');
}
export function decryptPage(page, pageNumber, keys) {
  if (!verifyPage(page, pageNumber, keys.mac)) throw new Error(`第 ${pageNumber} 页 HMAC 校验失败`);
  const cipher = createDecipheriv('aes-256-cbc', keys.encryption, page.subarray(4016, 4032));
  cipher.setAutoPadding(false);
  return Buffer.concat([...(pageNumber === 1 ? [SQLITE_HEADER] : []), cipher.update(page.subarray(pageNumber === 1 ? 16 : 0, 4016)), cipher.final(), Buffer.alloc(80)]);
}
export function eraseKeys(keys) { keys?.encryption.fill(0); keys?.mac.fill(0); }

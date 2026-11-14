import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const fields = ['lang', 'name', 'reply', 'company', 'topic', 'message'];

export async function openEnquiryStorage(db, dataDirectory, published) {
  let encodedKey = process.env.HR_ENQUIRY_KEY;
  const defaultKeyPath = process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA, 'AnnaEliseevaHR.key')
    : dataDirectory + '.key';
  const keyPath = resolve(process.env.HR_ENQUIRY_KEY_FILE || defaultKeyPath);
  if (!encodedKey && !published) {
    try {
      encodedKey = (await readFile(keyPath, 'utf8')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const hasEncrypted = db.prepare("SELECT 1 FROM enquiries WHERE lang = '' LIMIT 1").get();
      if (hasEncrypted) throw new Error('The existing enquiries require their original encryption key.');
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
      try {
        await writeFile(keyPath, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
      }
      encodedKey = (await readFile(keyPath, 'utf8')).trim();
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(encodedKey || '')) {
    throw new Error('Set HR_ENQUIRY_KEY to a persistent 32-byte key encoded as 64 hexadecimal characters.');
  }
  const key = Buffer.from(encodedKey, 'hex');

  function encrypt(id, receivedAt, values) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([id, receivedAt])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  function decrypt(row) {
    const bytes = Buffer.from(row.message, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([row.id, row.received_at])));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    return { id: row.id, received_at: row.received_at, ...JSON.parse(plain.toString('utf8')) };
  }

  // Authenticate the key before accepting traffic or changing older records.
  const check = db.prepare("SELECT * FROM enquiries WHERE lang = '' LIMIT 1").get();
  if (check) decrypt(check);
  const legacy = db.prepare("SELECT * FROM enquiries WHERE lang <> ''");
  const migrate = db.prepare("UPDATE enquiries SET lang='', name='', reply='', company='', topic='', message=? WHERE id=?");
  const needsMigration = db.prepare("SELECT 1 FROM enquiries WHERE lang <> '' LIMIT 1").get();
  if (needsMigration) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of legacy.iterate()) {
        const values = Object.fromEntries(fields.map(field => [field, row[field]]));
        migrate.run(encrypt(row.id, row.received_at, values), row.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const insert = db.prepare("INSERT INTO enquiries VALUES (?, ?, '', '', '', '', '', ?) ON CONFLICT(id) DO NOTHING");
  const existing = db.prepare('SELECT * FROM enquiries WHERE id = ?');
  const page = db.prepare('SELECT * FROM enquiries ORDER BY received_at DESC, id DESC LIMIT 26 OFFSET ?');
  const all = db.prepare('SELECT * FROM enquiries ORDER BY received_at DESC, id DESC');
  return {
    insert(id, receivedAt, values) {
      return insert.run(id, receivedAt, encrypt(id, receivedAt, values)).changes;
    },
    find: id => decrypt(existing.get(id)),
    page: offset => page.all(offset).map(decrypt),
    all: () => all.all().map(decrypt),
  };
}

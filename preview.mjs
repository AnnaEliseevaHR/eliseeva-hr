import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdmin } from './admin.mjs';
import { openEnquiryStorage } from './enquiry-storage.mjs';

const pages = ['index', 'business', 'career', 'experience', 'about', 'contact', 'privacy'];
const assets = {
  'styles.css': 'text/css; charset=utf-8',
  'site.js': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
  'og-cover.png': 'image/png',
  'anna-eliseeva.jpg': 'image/jpeg',
};
const files = new Map();
for (const directory of ['', 'en/']) {
  for (const page of pages) {
    const name = `${directory}${page}.html`;
    files.set('/' + name, [name, 'text/html; charset=utf-8']);
  }
}
files.set('/', files.get('/index.html'));
files.set('/en/', files.get('/en/index.html'));
for (const [asset, type] of Object.entries(assets)) {
  files.set('/assets/' + asset, ['assets/' + asset, type]);
}
files.set('/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']);

const published = process.argv.includes('--public');
const host = process.env.HR_HOST || '127.0.0.1';
const port = Number(process.env.PORT || process.env.HR_PREVIEW_PORT || 4178);
const origin = process.env.HR_ORIGIN || `http://${host}:${port}`;
const localAliases = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
function allowsOrigin(request) {
  const incoming = request.headers.origin;
  if (incoming === origin) return true;
  return !published && localAliases.has(origin) && localAliases.has(incoming)
    && incoming === `http://${request.headers.host}`;
}
const localDataDirectory = fileURLToPath(new URL('.hr-local-data', import.meta.url));
const dataDirectory = resolve(process.env.HR_DATA_DIR || localDataDirectory);
if (published && (!process.env.HR_DATA_DIR || new URL(origin).protocol !== 'https:')) {
  throw new Error('Public mode requires HR_DATA_DIR on a persistent volume and an HTTPS HR_ORIGIN.');
}
const publicPaths = ['', 'en/'].flatMap(prefix =>
  pages.map(page => '/' + prefix + (page === 'index' ? '' : page + '.html')));
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const publicUrl = path => xmlEscape(new URL(path, origin).href);
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + publicPaths.map(path => '<url><loc>' + publicUrl(path) + '</loc></url>').join('\n')
  + '\n</urlset>\n';

function addSearchMetadata(html, name) {
  const prefix = name.startsWith('en/') ? '/en/' : '/';
  const file = name.split('/').at(-1);
  const suffix = file === 'index.html' ? '' : file;
  const canonical = publicUrl(prefix + suffix);
  return html
    .replace(/<link rel="alternate" hreflang="(ru|en)" href="[^"]+">/g,
      (_, language) => '<link rel="alternate" hreflang="' + language + '" href="'
        + publicUrl((language === 'en' ? '/en/' : '/') + suffix) + '">')
    .replace(/(<meta property="og:image" content=")[^"]+/, '$1' + publicUrl('/assets/og-cover.png'))
    .replace('</head>', '<link rel="canonical" href="' + canonical + '">\n'
      + '<meta property="og:url" content="' + canonical + '">\n</head>');
}

await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDirectory, 'enquiries.sqlite'));
db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS enquiries (
    id TEXT PRIMARY KEY, received_at TEXT NOT NULL, lang TEXT NOT NULL,
    name TEXT NOT NULL, reply TEXT NOT NULL, company TEXT NOT NULL,
    topic TEXT NOT NULL, message TEXT NOT NULL
  );
`);

const deleteExpired = db.prepare(`
  DELETE FROM enquiries
  WHERE strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+1 month', 'floor') <= ?
`);
function purge() {
  deleteExpired.run(new Date().toISOString());
}
purge();
const storage = await openEnquiryStorage(db, dataDirectory, published);

if (process.argv.includes('--list-enquiries')) {
  console.log(JSON.stringify(storage.all(), null, 2));
  db.close();
  process.exit(0);
}

const admin = await createAdmin({ storage, allowsOrigin, published, dataDirectory, purge });
setInterval(() => {
  try {
    purge();
  } catch (error) {
    console.error('Enquiry cleanup failed:', error.code || error.name);
  }
}, 60_000).unref();

const topics = new Set(['recruitment', 'career', 'onboarding', 'partnership']);
const recent = new Map();
const rateWindow = 60_000;
let rateReset = 0;
let totalAttempts = 0;
const maxBodyBytes = 24_576;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function allowed(request) {
  const now = Date.now();
  if (now >= rateReset) {
    recent.clear();
    totalAttempts = 0;
    rateReset = now + rateWindow;
  }
  const key = request.socket.remoteAddress;
  const attempts = recent.get(key) || 0;
  if (attempts >= (published ? 30 : 60) || totalAttempts >= 120) return false;
  recent.set(key, attempts + 1);
  totalAttempts += 1;
  return true;
}

async function acceptEnquiry(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return json(response, 405, { error: 'method' });
  }
  if (!allowsOrigin(request)) return json(response, 403, { error: 'origin' });
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    return json(response, 415, { error: 'content_type' });
  }
  if (!allowed(request)) {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil((rateReset - Date.now()) / 1000))));
    return json(response, 429, { error: 'rate_limit' });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) {
      response.setHeader('Connection', 'close');
      json(response, 413, { error: 'too_large' });
      return;
    }
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return json(response, 400, { error: 'invalid' });
  }
  const fields = { name: [2, 100], reply: [3, 150], company: [0, 140], message: [10, 3000] };
  if (!data || data.consent !== true || data.website !== '' || !topics.has(data.topic)
    || !['ru', 'en'].includes(data.lang) || typeof data.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.id)) {
    return json(response, 400, { error: 'invalid' });
  }
  for (const [field, [min, max]] of Object.entries(fields)) {
    if (typeof data[field] !== 'string') return json(response, 400, { error: 'invalid' });
    data[field] = data[field].trim();
    if (data[field].length < min || data[field].length > max) {
      return json(response, 400, { error: 'invalid', field });
    }
  }
  const { id, lang, name, reply, company, topic, message } = data;
  const values = { lang, name, reply, company, topic, message };
  if (!storage.insert(id, new Date().toISOString(), values)) {
    const saved = storage.find(id);
    if (Object.keys(values).some(key => saved[key] !== values[key])) {
      return json(response, 409, { error: 'conflict' });
    }
  }
  return json(response, 200, { received: true });
}

const server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-HR-Site', 'anna-desktop-v1');
  try {
    const url = new URL(request.url, origin);
    const path = url.pathname;
    if (['/anna', '/anna/', '/anna/login', '/anna/logout'].includes(path)) {
      await admin(request, response, url);
      return;
    }
    if (path === '/api/enquiries') {
      await acceptEnquiry(request, response);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return json(response, 405, { error: 'method' });
    }
    if (published && (path === '/robots.txt' || path === '/sitemap.xml')) {
      const isSitemap = path === '/sitemap.xml';
      const body = isSitemap ? sitemap : 'User-agent: *\nAllow: /\nSitemap: ' + publicUrl('/sitemap.xml') + '\n';
      response.writeHead(200, { 'Content-Type': isSitemap ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const file = files.get(path);
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>404</title><link rel="stylesheet" href="/assets/styles.css"><main class="wrap section"><h1>Страница не найдена / Page not found</h1><a class="button dark" href="/">На главную</a> <a class="button dark" href="/en/" lang="en">English home</a></main>');
      return;
    }
    const [name, type] = file;
    let content = await readFile(new URL(name, import.meta.url));
    if (published && name.endsWith('.html')) {
      content = Buffer.from(addSearchMetadata(content.toString('utf8'), name));
    }
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (request.aborted) return;
    console.error('Request error:', error.code || error.name);
    if (!response.headersSent) json(response, 500, { error: 'server' });
    else response.end();
  }
});
server.listen(port, host, () => console.log(`Site: ${origin}/`));

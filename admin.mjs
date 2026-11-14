import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const hours = 8 * 60 * 60;
const topics = {
  recruitment: 'Подбор персонала', career: 'Карьерная консультация',
  onboarding: 'Адаптация', partnership: 'HR-сотрудничество',
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const digest = token => createHash('sha256').update(token).digest('hex');
const redirect = (response, location) => response.writeHead(303, { Location: location }).end();

function page(response, title, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Анна Елисеева</title>
<link rel="stylesheet" href="/assets/styles.css"></head><body>
<main class="wrap section admin"><h1>${title}</h1>${body}</main></body></html>`);
}

function login(response, error = '', status = 200) {
  page(response, 'Вход для Анны', `
<form method="post" action="/anna/login" class="contact-form">
${error ? `<p role="alert">${error}</p>` : ''}
<input hidden name="username" value="anna" autocomplete="username">
<div class="field"><label for="password">Пароль</label>
<input type="password" id="password" name="password" autocomplete="current-password" maxlength="256" required></div>
<p class="fine">Введите пароль кабинета, который был настроен при запуске сайта.</p>
<button class="button dark">Войти</button></form>
<p><a href="/">← На главную</a></p>`, status);
}

export async function createAdmin({ storage, allowsOrigin, published, dataDirectory, purge }) {
  const passwordPath = join(dataDirectory, 'anna-admin-password.txt');
  let password = process.env.HR_ADMIN_PASSWORD;
  const generatedPassword = !password && !published;
  if (!password && !published) {
    try {
      await writeFile(passwordPath, randomBytes(24).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    password = (await readFile(passwordPath, 'utf8')).trim();
    console.log('Local admin password file:', passwordPath);
  }
  if (!password || password.length < 16 || password.length > 256) {
    throw new Error('Set HR_ADMIN_PASSWORD to a strong password of 16–256 characters.');
  }
  const salt = randomBytes(16);
  const expected = scryptSync(password, salt, 64);
  const sessions = new Map();
  const cookieName = published ? '__Host-hr_session' : 'hr_session';
  const cookie = (token, age) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${published ? '; Secure' : ''}`;
  let failures = 0;
  let reset = 0;
  const dates = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' });

  return async function admin(request, response, url) {
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Referrer-Policy', 'same-origin');
    const token = request.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const key = token && digest(token);
    const now = Date.now();
    for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id);
    const signedIn = sessions.has(key);

    if (request.method === 'POST') {
      if (!allowsOrigin(request)) {
        return page(response, 'Доступ запрещён', '<p>Откройте страницу входа на сайте и отправьте форму заново.</p><a class="button dark" href="/anna/login">К странице входа</a>', 403);
      }
      if (url.pathname === '/anna/logout') {
        sessions.delete(key);
        response.setHeader('Set-Cookie', cookie('', 0));
        return redirect(response, '/anna/login');
      }
      if (url.pathname === '/anna/login') {
        if (now >= reset) {
          failures = 0;
          reset = now + 60_000;
        }
        if (failures >= 8) {
          response.setHeader('Retry-After', String(Math.ceil((reset - now) / 1000)));
          return login(response, 'Слишком много попыток. Повторите через минуту.', 429);
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
          return page(response, 'Проверьте данные формы', '', 415);
        }
        failures += 1;
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096) {
            response.setHeader('Connection', 'close');
            return page(response, 'Слишком большой запрос', '', 413);
          }
          chunks.push(chunk);
        }
        let candidate = new URLSearchParams(Buffer.concat(chunks).toString()).get('password');
        if (generatedPassword) candidate = candidate?.trim();
        if (!candidate || candidate.length > 256 || !timingSafeEqual(scryptSync(candidate, salt, 64), expected)) {
          return login(response, 'Неверный пароль.', 401);
        }
        failures = 0;
        sessions.delete(key);
        const fresh = randomBytes(32).toString('base64url');
        sessions.set(digest(fresh), now + hours * 1000);
        response.setHeader('Set-Cookie', cookie(fresh, hours));
        return redirect(response, '/anna');
      }
    }
    if (request.method !== 'GET') return page(response, 'Действие недоступно', '', 405);
    if (!signedIn) {
      if (url.pathname === '/anna/login') return login(response);
      return redirect(response, '/anna/login');
    }
    if (url.pathname !== '/anna') return redirect(response, '/anna');
    purge();
    const number = Number(url.searchParams.get('page') || '1');
    const current = Number.isSafeInteger(number) && number > 0 && number <= 100000 ? number : 1;
    const entries = storage.page((current - 1) * 25);
    const cards = entries.slice(0, 25).map(item => `
<article class="card"><time datetime="${escape(item.received_at)}">${dates.format(new Date(item.received_at))} (МСК)</time>
<h2>${escape(topics[item.topic] || item.topic)}</h2>
<p><strong>${escape(item.name)}</strong>${item.company ? ' · ' + escape(item.company) : ''}</p>
<p>Контакт для ответа · ${escape(item.reply)}</p>
<p class="admin-message">${escape(item.message)}</p></article>`).join('');
    page(response, 'Заявки', `
<div class="admin-actions"><a href="/">← На сайт</a><form action="/anna/logout" method="post">
<button class="button outline">Выйти</button></form></div>
<div class="admin-list">${cards || '<p>На этой странице пока нет заявок.</p>'}</div>
<nav class="admin-actions" aria-label="Страницы заявок">
${current > 1 ? `<a href="/anna?page=${current - 1}">← Новее</a>` : ''}
${entries.length > 25 ? `<a href="/anna?page=${current + 1}">Старее →</a>` : ''}
</nav>`);
  };
}

# Исправление CSRF и мобильной авторизации

## Источник сообщения и причина

Текст «Обновите страницу для защищённого соединения» формирует `backend/src/middleware/csrf.js`, когда cookie `btlgs_csrf` отсутствует, некорректна или не совпадает с заголовком `X-CSRF-Token`. Это отклонение до выполнения login/register/OAuth start/генерации.

В прежнем клиенте JSON-токен от `GET /api/auth/csrf` считался достаточным, даже если браузер отвергал ответную cookie. После 403 кеш только очищался, повторного получения и проверки не было. Сервер также менял токен при каждом GET, из-за чего другая вкладка могла обесценить токен первой вкладки.

В прямой схеме `vercel.app → onrender.com` обе cookies являются сторонними. Даже `SameSite=None; Secure` и credentialed CORS не обеспечивают их принятие Safari или Chrome с включённой блокировкой. Этот сбой воспроизведён локально в WebKit и Chromium: запрос CSRF успешно выдаёт JSON, но проверка cookie возвращает **403 / COOKIE_MISSING**. [WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/), [Chrome Android Incognito](https://support.google.com/chrome/answer/95464?co=GENIE.Platform%3DAndroid&hl=en).

Локальный `backend/.env` остаётся development, реальный Render URL в локальном `frontend/.env.production` до исправления был пустым. Окружение и логи опубликованного Render недоступны, поэтому исключить другие production причины (старый deploy, `SameSite=Lax` при прямом cross-site API, неверный cookie path) без проверки deployment нельзя. Новые Render-логи `csrf_rejected` содержат только reason и requestId: COOKIE_MISSING, COOKIE_INVALID, TOKEN_MISSING, TOKEN_MISMATCH или ORIGIN. Пароли, JWT, cookies и токены не логируются.

## Реализованное исправление

1. `frontend/vercel.ts` заменяет `vercel.json`, сохраняя SPA fallback и кеш статических assets. Правило `/api/:path*` проксирует на фиксированный реальный Render origin из `BACKEND_ORIGIN`. Browser URL остаётся на Vercel; нет редиректа браузера на Render и нет нового serverless обработчика файлов.
2. `VITE_API_URL=/api` разрешён в production. Backend остаётся на Render, авторизация — прежний JWT в HttpOnly cookie. Cookies без Domain, возвращённые через proxy, принадлежат домену frontend. Секреты не передаются в frontend.
3. Сервер переиспользует корректный CSRF-токен browser cookie и продлевает срок; некорректный или отсутствующий заменяет случайным 32-byte token. `GET /api/auth/csrf/check` проверяет возвращение cookie и совпадение заголовка без бизнес-операций и без выдачи новой cookie.
4. Клиент подтверждает cookie перед первой mutation, разделяет один запрос получения/проверки между одновременными запросами и сохраняет токен только в памяти. При CSRF-403 middleware отклонил запрос до бизнес-операции: клиент обновляет токен и повторяет mutation максимум один раз с прежним body и Idempotency-Key. Ошибки Origin, пароля, сети и сервера не повторяются. При отсутствии cookie проверка останавливает вход и выдаёт сообщение о недоступной cookie, без бесконечных попыток.
5. Cookies остаются HttpOnly и Secure в production. `Path=/api` для JWT/CSRF; `/api/auth/oauth` для OAuth binding. Host-only Domain не задаётся. Для proxy используется `SameSite=Lax`; Google top-level GET callback сохраняет binding cookie. CSRF-проверка, точный CORS allowlist, state, PKCE и nonce сохранены. JWT не сохраняется в localStorage.
6. Все API-ответы, включая ранние OAuth callbacks, получают запрет CDN-кеширования. Клиентские CSRF и JSON API-запросы используют `cache: no-store` и `credentials: include`.

Не ставь `Domain=onrender.com` или `.vercel.app`: cookie нельзя разделить между этими сайтами. Для текущего proxy собственный домен не требуется. Альтернатива — HTTPS frontend и API на поддоменах одного собственного сайта, с отдельной корректной настройкой CORS.

## Настройки деплоя

Vercel, Root Directory **frontend**, Framework **Vite**:

```dotenv
VITE_API_URL=/api
BACKEND_ORIGIN=<реальный HTTPS origin вашего сервиса Render, без /api>
```

`BACKEND_ORIGIN` — непубличная Vercel environment variable без префикса VITE. `vercel.ts` читает её при деплое; отсутствие/неверный origin останавливает настройку маршрутов. Код не придумывает имя сервиса. Для Preview задавай соответствующие переменные и точные разрешённые frontend origins; произвольные preview домены не добавляются автоматически. После изменения переменных нужен Redeploy.

Render:

```dotenv
NODE_ENV=production
CORS_ORIGINS=https://betelgeuse-ai.vercel.app
FRONTEND_URL=https://betelgeuse-ai.vercel.app
COOKIE_CROSS_SITE=false
TRUST_PROXY=1
GOOGLE_REDIRECT_URI=https://betelgeuse-ai.vercel.app/api/auth/oauth/google/callback
```

Сохрани JWT_SECRET, PostgreSQL, Google и R2/Higgsfield secrets на backend. Не меняй их из-за этого исправления. Для локального HTTP development остаются прежние `SameSite=Lax`, `Secure=false`, `COOKIE_CROSS_SITE=false` и Vite proxy.

Google Cloud Console → Web Application → Authorized redirect URIs: добавь **https://betelgeuse-ai.vercel.app/api/auth/oauth/google/callback**. Google теперь возвращает браузер через Vercel proxy, а обработчик по-прежнему выполняется на Render. Это обязательно: callback напрямую на Render не получит host-only binding cookie, установленную на Vercel. Сохрани локальные callback URLs для разработки. Проверка одноразового state и cookie привязки не отключена.

Сначала подготовь переменные и Google redirect URI, затем согласованно обнови backend и frontend. Новый клиент требует backend route `/api/auth/csrf/check`. После деплоя старые Render cookies не становятся Vercel cookies; потребуется новый вход, backend secret менять не нужно. Реальный деплой в этой задаче не выполнялся.

[Programmatic Vercel config](https://vercel.com/docs/project-configuration/vercel-ts), [external rewrites](https://vercel.com/docs/routing/rewrites).

## Проверки и пределы

- Frontend: **10 тестов прошли** — получение/проверка, совместные запросы, смена токена, ограничение retries, blocked cookies, headers, FormData, Idempotency-Key, proxy configuration.
- Backend: **37 прошли, 5 PostgreSQL-тестов пропущены**. Проверены cookie attributes, стабильность между вкладками, CSRF reasons, отсутствие authentication reads при отклонении и отказ неизвестным origins.
- Production build выполнен успешно. Конфигурация `vercel.ts` отдельно загружена с тестовым Render origin; он не записан в реальные env-файлы.
- Локальный HTTPS browser check: WebKit и Chromium с mobile viewport/touch. В Chromium включена блокировка third-party cookies через CDP. Для прямого cross-site API оба возвращают COOKIE_MISSING; same-origin proxy работает. Проверены реальные browser cookies, login/profile/logout, две вкладки, истёкшая CSRF-cookie, Google binding callback и полный отказ cookie до login.
- Windows WebKit cookie inspector сообщает SameSite=None даже для ответного `Set-Cookie: SameSite=Lax`; Lax проверен по HTTP-заголовку, host/path/HttpOnly/Secure — по browser cookie store. Это не тест физического iPhone.
- Browser check использовал fake users/OAuth persistence и временный self-signed localhost certificate. Worker, PostgreSQL и миграции не запускались. Артефакты — `artifacts/api-qa/csrf-mobile.mjs` и `csrf-mobile-results.json`, они игнорируются Git.

После реального deploy проверь Safari iOS, Chrome Android и Chrome Incognito: login, обновление страницы, logout, Google OAuth и две вкладки. `/api/auth/csrf/check` должен вернуть 200; session/CSRF cookies должны быть на `betelgeuse-ai.vercel.app`, без Domain и с Secure/HttpOnly/Lax. Отключать защиту браузера пользователям не требуется. Если отключены вообще все cookies, безопасная cookie-сессия невозможна: клиент показывает ошибку, а не обходит защиту.

Изменения: `frontend/src/services/api.js`, `api-url.js`, `.env.production`, `.env.example`, `vercel.ts`, новый `scripts/vercel-config.js`, `tests/api.test.js`, новый `tests/vercel-config.test.js`; удалён заменённый `frontend/vercel.json`. Backend: `src/middleware/csrf.js`, `errors.js`, `src/routes/auth.routes.js`, `src/app.js`, `.env.example`, новый `tests/csrf.test.js`. Документация: этот файл, `RENDER-VERCEL.md`, `SUPABASE-RENDER.md`, README. База и миграции не изменялись.

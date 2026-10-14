# API: локальная разработка и Render + Vercel

Production frontend: **https://betelgeuse-ai.vercel.app**. Публичный URL backend пока неизвестен; в конфигурацию он не подставлялся. В этой задаче миграции и запросы к реальной базе данных не выполнялись.

Мобильная авторизация использует same-origin Vercel proxy. [Диагностика CSRF, исправление и проверка браузеров](MOBILE-AUTH.md).

## Frontend

Все backend-запросы проходят через `frontend/src/services/api.js`: auth, Google OAuth start, профиль, баланс, модели, генерации, polling, история, админка, тренды, загрузки и скачивания. URL приватных изображений библиотеки строится тем же `apiUrl()`.

`VITE_API_URL=/api` используется и в production, и в development. `/api` добавляется один раз: `api('/auth/me')` и `api('/api/auth/me')` обращаются к одному `/api/auth/me`. Production проксирует запросы через Vercel, development — через Vite. Прямые HTTPS origins также поддерживаются, но прямой cross-site API ненадёжен для мобильной cookie-авторизации.

| Файл | Назначение |
| --- | --- |
| `frontend/.env.development` | `VITE_API_URL=/api`, `API_PROXY_TARGET=http://127.0.0.1:4000` |
| `frontend/.env.production` | `VITE_API_URL=/api`, Render origin задаётся отдельно в Vercel |
| `frontend/.env.example` | Шаблон переменных и пояснения для обоих режимов |

Файлы `.env.development` и `.env.production` созданы локально и исключены существующими правилами Gitignore. Для Vercel задавай значение в Dashboard, не полагайся на локальные игнорируемые файлы.

В **Vercel → Settings → Environment Variables** добавь `VITE_API_URL=/api` и `BACKEND_ORIGIN`, равный реальному HTTPS origin Render без path, затем сделай **Redeploy**. `vercel.ts` строит внешний rewrite из этой переменной. Для Production и Preview переменные задаются отдельно. Не разрешай произвольные preview origins на backend: добавляй конкретные доверенные HTTPS origins при необходимости. `API_PROXY_TARGET` в Vercel не нужен: он используется только development-сервером Vite.

Локальная production-сборка работает с `/api`. Деплой Vercel требует реальный `BACKEND_ORIGIN` и отклоняет пустую или неверную настройку. Не помещай JWT, Google client secret, R2 или PostgreSQL credentials в `VITE_*`: эти переменные попадают в публичный JavaScript. [Переменные Vite](https://vite.dev/guide/env-and-mode).

Прямая отправка фото в R2 по временным signed URLs остаётся с `credentials: 'omit'`: cookies backend нельзя отправлять в объектное хранилище. Внешние URL провайдера, R2-видео и Telegram SDK не заменяются на API origin.

## Backend: Render Environment

| Переменная | Значение |
| --- | --- |
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | `https://betelgeuse-ai.vercel.app` |
| `FRONTEND_URL` | `https://betelgeuse-ai.vercel.app` |
| `COOKIE_CROSS_SITE` | `false` для same-origin Vercel proxy |
| `TRUST_PROXY` | `1` |
| `DATABASE_URL`, `DIRECT_URL` | Уже проверенные подключения Supabase, только на backend |
| `JWT_SECRET` | Постоянный случайный секрет минимум 32 символа |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credentials Web Application из Google Cloud |
| `GOOGLE_REDIRECT_URI` | `https://betelgeuse-ai.vercel.app/api/auth/oauth/google/callback` через proxy |

Существующие R2/Higgsfield/Telegram переменные переноси по используемым функциям. `PORT` предоставляет Render. Build/start, генерация Prisma Client и настройки базы описаны в [SUPABASE-RENDER.md](SUPABASE-RENDER.md); повторный деплой здесь не выполнялся.

`CORS_ORIGINS` — список точных origins через запятую, без завершающего `/`, путей и wildcard. В production разрешены только HTTPS origins; HTTP localhost остаётся для локального development backend. `FRONTEND_URL` должен входить в этот список. OAuth сохраняет проверенный origin инициировавшего вход frontend, поэтому локальные origins продолжают корректно работать. Для callback без действительного OAuth attempt fallback задаётся через `FRONTEND_URL`, а не порядком списка CORS.

## Cookies и ограничения браузеров

Backend сохраняет `credentials: true` в CORS. Frontend отправляет `credentials: 'include'` для всех backend-запросов, включая CSRF и скачивание. Сессионная и CSRF cookies — `HttpOnly`, с ограниченным path `/api`; production — `Secure`, `SameSite=None` при `COOKIE_CROSS_SITE=true`. Локальный HTTP backend сохраняет `SameSite=Lax` и не включает `Secure`. Cross-site режим в development запрещён. Проверка CSRF и точного Origin сохранена.

Между `vercel.app` и `onrender.com` cookies являются сторонними. `SameSite=None; Secure` и правильный CORS **не обходят** ограничения Safari, Firefox, приватных режимов или пользовательской блокировки third-party cookies. Поэтому без реальных deployed URLs нельзя гарантировать вход во всех браузерах. [Ограничения credentialed CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS#third-party_cookies).

В текущей реализации добавлен same-origin proxy: browser обращается к `/api` на Vercel, и cookies становятся собственными с `SameSite=Lax`. Собственный домен для этой схемы не требуется. Альтернатива — frontend и API на HTTPS-поддоменах одного собственного домена с `COOKIE_CROSS_SITE=false` и правильными CORS origins.

## Google Cloud Console

OAuth client type: **Web application**. В Authorized redirect URIs добавь точные адреса:

- `http://127.0.0.1:5173/api/auth/oauth/google/callback` — текущий локальный Vite proxy.
- `http://localhost:5173/api/auth/oauth/google/callback` — если используешь localhost и меняешь `GOOGLE_REDIRECT_URI` соответственно.
- `https://betelgeuse-ai.vercel.app/api/auth/oauth/google/callback` — production через proxy.

Callback с кодом Google идёт **через Vercel proxy на backend**, затем backend возвращает браузер на `https://betelgeuse-ai.vercel.app/?auth_result=success` и frontend проверяет существующую сессию. Callback должен проходить через тот же browser origin, где установлена HttpOnly binding cookie. PKCE, nonce, state, проверка ID token и создание/поиск аккаунта сохранены. Redirect URI должен точно совпадать с переменной, включая path, protocol и port. [Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

Текущий server-side flow не требует JavaScript origins для Google SDK. Если настраиваешь это поле, используй `https://betelgeuse-ai.vercel.app`, `http://127.0.0.1:5173` и `http://localhost:5173`, без path. Настрой consent screen, тестовых пользователей для Testing и production publishing по готовности приложения. Google client secret хранится только на Render.

## Локальный запуск и проверки

Запускай backend как раньше: из `backend` выполни `npm run dev`, frontend — из `frontend` выполни `npm run dev`. Используй `http://127.0.0.1:5173` для текущего локального Google callback; `/api` проксируется на `http://127.0.0.1:4000`. Локальные backend значения: `NODE_ENV=development`, `COOKIE_CROSS_SITE=false`, `TRUST_PROXY=0`, CORS с localhost/127.0.0.1, `FRONTEND_URL=http://127.0.0.1:5173`.

Frontend проверки: `npm test`, `npm run build`. Backend: `npm test` без `TEST_DATABASE_URL` и с фиктивным `DATABASE_URL`, чтобы не обращаться к Supabase. `test:db` не запускался: он создаёт временную PostgreSQL и применяет миграции. Production login/CSRF/session/logout и Google OAuth start проверены через HTTP с подставными данными; настоящий вход Google и Render ↔ Vercel нужно проверить после получения домена и credentials.

После исправления mobile CSRF: frontend — 10 тестов прошли; backend — 37 прошли, 5 PostgreSQL-тестов пропущены. Production build успешен. WebKit/Chromium проверены через локальный HTTPS proxy, подробнее в [MOBILE-AUTH.md](MOBILE-AUTH.md). Worker и обращения к PostgreSQL не запускались.

## Изменённые файлы

- Основная конфигурация API: frontend `src/services/api.js`, `api-url.js`, `Library.jsx`, Vite/env-файлы; backend env и OAuth-контроллер/сервис.
- Исправление mobile CSRF: `frontend/vercel.ts`, `scripts/vercel-config.js`, API-клиент и тесты; backend `csrf.js`, `errors.js`, `auth.routes.js`, `app.js`, `tests/csrf.test.js`. `vercel.json` заменён новым config.
- Полный список и текущие проверки: [MOBILE-AUTH.md](MOBILE-AUTH.md).

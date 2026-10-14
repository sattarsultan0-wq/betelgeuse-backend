# API: локальная разработка и Render + Vercel

Production frontend: **https://betelgeuse-ai.vercel.app**. Публичный URL backend пока неизвестен; в конфигурацию он не подставлялся. В этой задаче миграции и запросы к реальной базе данных не выполнялись.

## Frontend

Все backend-запросы проходят через `frontend/src/services/api.js`: auth, Google OAuth start, профиль, баланс, модели, генерации, polling, история, админка, тренды, загрузки и скачивания. URL приватных изображений библиотеки строится тем же `apiUrl()`.

`VITE_API_URL` принимает **origin backend** либо origin с `/api`. `/api` добавляется один раз: `api('/auth/me')` и `api('/api/auth/me')` обращаются к одному `/api/auth/me`. Production принимает только абсолютный HTTPS URL, development поддерживает `/api` через Vite proxy.

| Файл | Назначение |
| --- | --- |
| `frontend/.env.development` | `VITE_API_URL=/api`, `API_PROXY_TARGET=http://127.0.0.1:4000` |
| `frontend/.env.production` | `VITE_API_URL=` намеренно пуст до получения Render URL |
| `frontend/.env.example` | Шаблон переменных и пояснения для обоих режимов |

Файлы `.env.development` и `.env.production` созданы локально и исключены существующими правилами Gitignore. Для Vercel задавай значение в Dashboard, не полагайся на локальные игнорируемые файлы.

В **Vercel → Settings → Environment Variables** добавь `VITE_API_URL`, равный реальному HTTPS origin Render, и сделай **Redeploy**. Для Production и Preview переменные задаются отдельно. Не разрешай произвольные preview origins на backend: добавляй конкретные доверенные HTTPS origins при необходимости. `API_PROXY_TARGET` в Vercel не нужен: он используется только development-сервером Vite.

Без production URL UI собирается с явным предупреждением; API-клиент сообщает, что `VITE_API_URL` не настроен, и не делает запросы на локальный адрес или домен frontend. После получения URL также можешь заполнить `frontend/.env.production` для локальной production-сборки. Не помещай JWT, Google client secret, R2 или PostgreSQL credentials в `VITE_*`: эти переменные попадают в публичный JavaScript. [Переменные Vite](https://vite.dev/guide/env-and-mode).

Прямая отправка фото в R2 по временным signed URLs остаётся с `credentials: 'omit'`: cookies backend нельзя отправлять в объектное хранилище. Внешние URL провайдера, R2-видео и Telegram SDK не заменяются на API origin.

## Backend: Render Environment

| Переменная | Значение |
| --- | --- |
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | `https://betelgeuse-ai.vercel.app` |
| `FRONTEND_URL` | `https://betelgeuse-ai.vercel.app` |
| `COOKIE_CROSS_SITE` | `true` для текущей пары `vercel.app` + `onrender.com` |
| `TRUST_PROXY` | `1` |
| `DATABASE_URL`, `DIRECT_URL` | Уже проверенные подключения Supabase, только на backend |
| `JWT_SECRET` | Постоянный случайный секрет минимум 32 символа |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credentials Web Application из Google Cloud |
| `GOOGLE_REDIRECT_URI` | Реальный HTTPS origin Render + `/api/auth/oauth/google/callback` |

Существующие R2/Higgsfield/Telegram переменные переноси по используемым функциям. `PORT` предоставляет Render. Build/start, генерация Prisma Client и настройки базы описаны в [SUPABASE-RENDER.md](SUPABASE-RENDER.md); повторный деплой здесь не выполнялся.

`CORS_ORIGINS` — список точных origins через запятую, без завершающего `/`, путей и wildcard. В production разрешены только HTTPS origins; HTTP localhost остаётся для локального development backend. `FRONTEND_URL` должен входить в этот список. OAuth сохраняет проверенный origin инициировавшего вход frontend, поэтому локальные origins продолжают корректно работать. Для callback без действительного OAuth attempt fallback задаётся через `FRONTEND_URL`, а не порядком списка CORS.

## Cookies и ограничения браузеров

Backend сохраняет `credentials: true` в CORS. Frontend отправляет `credentials: 'include'` для всех backend-запросов, включая CSRF и скачивание. Сессионная и CSRF cookies — `HttpOnly`, с ограниченным path `/api`; production — `Secure`, `SameSite=None` при `COOKIE_CROSS_SITE=true`. Локальный HTTP backend сохраняет `SameSite=Lax` и не включает `Secure`. Cross-site режим в development запрещён. Проверка CSRF и точного Origin сохранена.

Между `vercel.app` и `onrender.com` cookies являются сторонними. `SameSite=None; Secure` и правильный CORS **не обходят** ограничения Safari, Firefox, приватных режимов или пользовательской блокировки third-party cookies. Поэтому без реальных deployed URLs нельзя гарантировать вход во всех браузерах. [Ограничения credentialed CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS#third-party_cookies).

Для устойчивой авторизации используй frontend и API на HTTPS-поддоменах **одного собственного домена** либо настрой отдельно same-origin proxy. В первом варианте обнови `VITE_API_URL`, `CORS_ORIGINS`, `FRONTEND_URL`, Google callback и поставь `COOKIE_CROSS_SITE=false`: HTTPS поддомены одного сайта используют `SameSite=Lax`, но всё ещё требуют CORS и `credentials: include`. Сам домен здесь не выбирался и proxy не добавлялся.

## Google Cloud Console

OAuth client type: **Web application**. В Authorized redirect URIs добавь точные адреса:

- `http://127.0.0.1:5173/api/auth/oauth/google/callback` — текущий локальный Vite proxy.
- `http://localhost:5173/api/auth/oauth/google/callback` — если используешь localhost и меняешь `GOOGLE_REDIRECT_URI` соответственно.
- После получения Render URL: реальный HTTPS backend origin + `/api/auth/oauth/google/callback`.

Callback с кодом Google идёт **на backend**, затем backend возвращает браузер на `https://betelgeuse-ai.vercel.app/?auth_result=success` и frontend проверяет существующую сессию. Frontend URL не заменяет Google redirect URI. PKCE, nonce, state, проверка ID token и создание/поиск аккаунта сохранены. Redirect URI должен точно совпадать с переменной, включая path, protocol и port. [Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

Текущий server-side flow не требует JavaScript origins для Google SDK. Если настраиваешь это поле, используй `https://betelgeuse-ai.vercel.app`, `http://127.0.0.1:5173` и `http://localhost:5173`, без path. Настрой consent screen, тестовых пользователей для Testing и production publishing по готовности приложения. Google client secret хранится только на Render.

## Локальный запуск и проверки

Запускай backend как раньше: из `backend` выполни `npm run dev`, frontend — из `frontend` выполни `npm run dev`. Используй `http://127.0.0.1:5173` для текущего локального Google callback; `/api` проксируется на `http://127.0.0.1:4000`. Локальные backend значения: `NODE_ENV=development`, `COOKIE_CROSS_SITE=false`, `TRUST_PROXY=0`, CORS с localhost/127.0.0.1, `FRONTEND_URL=http://127.0.0.1:5173`.

Frontend проверки: `npm test`, `npm run build`. Backend: `npm test` без `TEST_DATABASE_URL` и с фиктивным `DATABASE_URL`, чтобы не обращаться к Supabase. `test:db` не запускался: он создаёт временную PostgreSQL и применяет миграции. Production login/CSRF/session/logout и Google OAuth start проверены через HTTP с подставными данными; настоящий вход Google и Render ↔ Vercel нужно проверить после получения домена и credentials.

Результат текущей проверки: frontend — 3 теста прошли; backend — 32 прошли, 5 PostgreSQL-тестов пропущены, ошибок нет. Production build выполнен с пустым URL и отдельно с явно тестовым origin, заданным только в процессе сборки. Локальный Vite proxy для localhost и 127.0.0.1 вернул 200 на `/api/models` и `/api/auth/csrf`, 401 без сессии на `/api/auth/me`; cookies сохранили `HttpOnly; SameSite=Lax` без `Secure` для HTTP. Worker и обращения к PostgreSQL не запускались.

## Изменённые файлы

- Frontend: `src/services/api.js`, новый `src/services/api-url.js`, `src/pages/Library.jsx`, `vite.config.js`, `package.json`, `.env.example`, новые `.env.development`, `.env.production`, `tests/api.test.js`.
- Backend: `src/config/env.js`, `src/controllers/oauth.controller.js`, `src/services/oauth.service.js`, `.env.example`, `scripts/check-supabase-app.js` (учёт нового `FRONTEND_URL`, проверка не запускалась), новый `tests/deployment.test.js`.
- Документация: этот файл, `SUPABASE-RENDER.md`, корневой `README.md`.

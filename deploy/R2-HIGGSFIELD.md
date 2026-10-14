# Тренды: приватный R2 и Higgsfield

Реализован процесс: Showcase → выбор фотографий → presigned PUT напрямую в R2 → серверная проверка → существующая очередь и квота → polling Higgsfield → копия результата в R2 → просмотр, скачивание и библиотека. Фотографии и результаты приватные. Публичные ролики Showcase служат только примерами.

## Подготовка backend

В `backend`:

```powershell
npm ci
npm run prisma:generate
# БД должна быть запущена в отдельном терминале через npm run db:start.
npm run db:migrate
```

Добавьте в существующий `backend/.env`:

```env
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=betelgeuse-uploads
R2_INPUT_URL_TTL_SECONDS=86400

HIGGSFIELD_API_KEY_ID=
HIGGSFIELD_API_KEY_SECRET=
HIGGSFIELD_ENABLED=false
```

Используются **существующие** имена `HIGGSFIELD_API_KEY_ID` и `HIGGSFIELD_API_KEY_SECRET`, а не `HIGGSFIELD_API_KEY`/`HIGGSFIELD_API_SECRET`. Заголовок: `Authorization: Key KEY_ID:KEY_SECRET`. Ключи не добавлять в frontend или `VITE_*`.

`HIGGSFIELD_ENABLED=true` включает платные задачи для пользователей с квотой. В рамках разработки реальные задачи не отправлялись. Включайте провайдера после заполнения конфигурации и проверки баланса. Квота выдаётся существующей командой `npm run quota:grant -- <email> <credits>`; регистрация по умолчанию даёт 0.

## Cloudflare R2 вручную

1. Создайте отдельный bucket `betelgeuse-uploads`. Отключите Public Development URL (`r2.dev`) и публичные custom domains для этого bucket. Публичные примеры Showcase можно оставить в другом bucket.
2. Создайте R2 S3 API credentials с Object Read & Write только для этого bucket. Account ID, Access Key ID и Secret Access Key сохраните на backend.
3. В bucket → Settings → CORS Policy вставьте [r2-cors.example.json](./r2-cors.example.json). В production замените localhost на **точные** HTTPS origins фронтенда из `CORS_ORIGINS`, без завершающего `/` и без `*`. Разрешены PUT, GET, HEAD, Content-Type и Range.
4. Создайте lifecycle rule: удаление объектов с префиксом `pending/` через 1 день. Клиент может повторно использовать PUT до истечения его 10 минут; очистка после проверки не исключает повторную запись в `pending/`. Эта запись никогда не становится входом генерации.
5. Выберите сроки хранения `images/` и `results/` согласно вашей политике. Не применяйте правило `pending/` ко всему bucket. Удаление входных фотографий во время обработки приведёт к ошибке провайдера; удаление результата сделает сохранённую запись истории недоступной.

Presigned PUT подписывает тип и длину, а сервер дополнительно проверяет HEAD, фактическое число байтов, сигнатуру файла и декодирование Sharp. Допустимы JPEG, PNG, WebP до 10 МБ и 25 мегапикселей. Сервер преобразует фотографию в JPEG без исходных EXIF-метаданных и копирует в новый `images/<userId>/<uuid>.jpg`, на который клиент никогда не получает PUT. Ключи задаются сервером; подтвердить или использовать чужую загрузку нельзя.

## Промпты и модели

Редактируйте `generationOverrides` в `backend/src/config/trends.js`. Промпты намеренно пустые: до заполнения сервер отклоняет загрузку/генерацию, а кнопка интерфейса недоступна. Настройки оплачиваемого запроса берутся только отсюда и `models.js`, клиент передаёт только `trendId` и проверенные `photoKeys`. Метаданные примеров (title, src, poster, previewUrl, mediaAspectRatio) находятся в едином `backend/src/config/showcase-media.js`.

Пример настройки одного фото:

```js
litvin: {
  title: 'Litvin Trend',
  videoUrl: 'https://your-public-showcase-domain/litvin.mp4',
  prompt: 'Ваш собственный промпт',
  model: 'kling',
  mode: 'IMAGE_TO_VIDEO',
  minPhotos: 1,
  maxPhotos: 1,
  duration: 5,
  quality: 'standard',
  aspectRatio: 'source',
},
```

По умолчанию генератор и все тренды используют Kling 3.0 Standard: `model: 'kling'`, `quality: 'standard'`. Это название режима модели, а не обещание конкретного разрешения. API этой модели не принимает `resolution`. Длительность в приложении — 5/10 секунд, стоимость внутренней квоты — 1/2 единицы; для администратора 0. Звук выключен на сервере через `sound: 'off'`.

Проверенные схемы Kling 3.0:

- [Image-to-Video](https://open.higgsfield.ai/models/kling-video/v3.0/std/image-to-video/api-reference): `kling-video/v3.0/std/image-to-video`, `image_url`, prompt, duration, sound, cfg_scale, multi_shots. Принимает одно исходное фото; соотношение сторон следует из фотографии.
- [Text-to-Video](https://open.higgsfield.ai/models/kling-video/v3.0/std/text-to-video/api-reference): `kling-video/v3.0/std/text-to-video`, prompt, duration, aspect_ratio, sound, cfg_scale, multi_shots.
- [Официальный SDK и polling](https://github.com/higgsfield-ai/higgsfield-js): receipt `request_id`, polling `/requests/{request_id}/status`, итоговый `video.url`.

Seedance 2.0 и Veo отключены для новых генераций. Старые результаты Seedance остаются в истории; модель сохранённых записей не переписывается. Код адаптера Seedance сохранён для отдельного явного включения. Режим `REFERENCE_TO_VIDEO` с 2–4 фотографиями у Kling Standard не поддерживается: сервер отклоняет такую конфигурацию вместо отправки лишних параметров или переключения на дорогую модель. Поле Kling `elements` ожидает идентификаторы элементов, а не произвольные URL фото; подготовки элементов в проекте пока нет.

Чтобы подключить другую модель, добавьте проверенные capabilities в `models.js` и соответствующее отображение параметров в `providerPayload` в `higgsfield.service.js` по официальной схеме. Пример видео Showcase автоматически не отправляется провайдеру.

Новый пример добавляется в `showcaseMedia` в `backend/src/config/showcase-media.js`: он появится в VideoShowcase через `GET /api/trends`, а при публичном HTTPS `src` — также в Workspace `/trends`. `poster` и необязательный облегчённый `previewUrl` задаются в этой же записи. Для Litvin `trendId: 'litvin'` остаётся серверным идентификатором генерации. Приложение использует URL из API; отдельного frontend-массива и приоритета локального URL больше нет. `frontend/src/assets/showcase.js` оставлен только как совместимый экспорт для `videos:prepare`.

## API

| Метод и маршрут | Назначение |
| --- | --- |
| `GET /api/trends` | Публичные примеры, число фотографий, доступность, квота; без промптов и API credentials |
| `POST /api/trends/uploads/presign` | `{trendId, files: [{mimeType, size}]}` → uploadId, временный PUT URL, обязательные headers |
| `POST /api/trends/uploads/complete` | `{uploadId}` → серверная проверка и `{image: {id, key, mimeType, size}}` |
| `POST /api/trends/generations` | `{trendId, photoKeys}` + UUID `Idempotency-Key` → generation, HTTP 202 |

Все POST требуют авторизации и `X-CSRF-Token`. Для browser PUT в R2 не передавайте cookie, CSRF или Higgsfield credentials. После ошибки PUT/complete frontend не создаёт задачу.

Повторно используются `GET /api/generations/:id`, `GET /api/generations`, `GET /api/users/me/generations` и `GET /api/generations/:id/download`. Ответ статуса/истории создаёт новый GET URL результата на 1 час. Ключ результата хранится в БД, а временный URL — нет. После истечения ссылки запросите статус снова или переоткройте модалку/библиотеку. Скачивание проходит через backend с проверкой владельца.

## Ссылки, повторы и ошибки

Ссылки на входные фото создаются worker непосредственно перед единственной отправкой задачи. Срок — 24 часа (`R2_INPUT_URL_TTL_SECONDS`, максимум 7 дней); настройте его с запасом под задержки provider queue. API не может продлить уже отправленную ссылку у Higgsfield. По умолчанию локальная задача истекает через 20 минут от создания (`GENERATION_TIMEOUT_MS`), значительно раньше срока чтения. При увеличении timeout увеличьте срок ссылок и срок хранения фотографий.

Квота списывается атомарно вместе с созданием существующей Generation. Повтор с тем же ключом/данными возвращает ту же запись. Frontend сохраняет неподтверждённый запрос и ключ в sessionStorage на пользователя/тренд и повторяет именно его. Это состояние восстанавливается в пределах той же вкладки, включая reload.

Для трендов `submissionAttemptedAt` сохраняется **до** POST к Higgsfield. Если receipt не подтверждён (обрыв соединения, timeout, падение процесса), повторный платный POST запрещён, задача помечается failed с `requiresReview: true`. Квота сохраняется до сверки. Заголовок Idempotency-Key провайдеру не считается гарантией дедупликации. Оператор должен найти задачу в Higgsfield Console: при подтверждённом request_id записать его и точный status_url в Generation, вернуть статус queued для продолжения polling; при подтверждённом отсутствии задачи вернуть квоту один раз и отметить quotaRefunded. Не очищайте маркер для слепого повтора.

После получения receipt повторяются только GET статуса и сохранение готового видео. Ошибка R2 не запускает новое видео. Результат ограничен 200 МБ, проверяется как MP4 и скачивается через существующую защиту SSRF с allowlist `PROVIDER_MEDIA_HOSTS`. При появлении другого официального CDN добавьте точный host после проверки, без wildcard. Ссылки, секреты и изображения не пишутся в журналы ошибок.

Ограничения: 5 запросов генерации в минуту на пользователя, 30 запросов trend API в минуту, 40 зарезервированных фотографий в час, существующий общий API rate limit и `MAX_ACTIVE_GENERATIONS`. Rate limit в памяти процесса; для нескольких API-инстансов понадобится общий store. Часовой лимит фотографий и квота проверяются в PostgreSQL и действуют между инстансами.

## Проверки

```powershell
# frontend
npm run build
# backend: схема, клиент и текущие тесты
npm run prisma:generate
npx prisma validate
npm test
# все тесты, включая БД, в отдельном временном PostgreSQL
npm run test:db
```

У backend нет стадии сборки (исполняемый Node.js ESM); проверены синтаксис модулей, Prisma и тесты. `test:db` применяет миграции к временному кластеру и удаляет его после проверки, не изменяя рабочую БД. R2 и Higgsfield в lifecycle-тестах заменены адаптерами; реальные платные запросы не выполняются. Browser QA в `artifacts/trends-browser-qa.mjs` также перехватывает API и PUT; проверяет сбой загрузки, повтор с тем же ключом, восстановление результата и размеры 1440/390/320.

До реального smoke test нужны R2 credentials, ручные настройки bucket, заполненные промпты, доступ аккаунта Higgsfield к выбранной модели, квота пользователя и разрешение на платную генерацию. Переключение на Kling проверяется локальными тестами; второй платный тест не выполнялся.

Реальная проверка 13.10.2026 пройдена по разрешению владельца: один запрос Seedance Image-to-Video, 5 секунд, 480p. Браузерный PUT, серверная проверка изображения, polling, сохранение в приватный R2, просмотр в библиотеке и скачивание проверены. Полученный MP4: 864×496, около 367 КБ. Для пользователя Sultan квота не списывалась. Выходной CDN из подтверждённого ответа Higgsfield — `d3u0tzju9qaucj.cloudfront.net`; этот точный host добавлен в локальный `PROVIDER_MEDIA_HOSTS`. При блокировке неизвестного CDN worker теперь показывает причину настройки вместо общей ошибки.

Тестовый промпт задавался только в процессе проверки; серверные промпты трендов оставлены пустыми. `HIGGSFIELD_ENABLED` в `.env` оставлен `false`, чтобы не включать всю очередь после одного разрешённого теста. Ключи R2 перенесены из `.env.example` в игнорируемый `.env`, пример очищен от credentials. Точные расходы Higgsfield проверяются в Console; API статуса их не сообщает. Артефакты проверки находятся в игнорируемой папке `artifacts/live-smoke/`.

## Файлы

Изменены существующие: `backend/package.json`, `backend/package-lock.json`, `backend/.env.example`, `backend/prisma/schema.prisma`, `backend/src/app.js`, `backend/src/config/env.js`, `backend/src/config/models.js`, `backend/src/controllers/generation.controller.js`, `backend/src/controllers/upload.controller.js`, `backend/src/services/generation.service.js`, `backend/src/services/higgsfield.service.js`, `backend/src/jobs/generation.worker.js`, `frontend/src/assets/showcase.js`, `frontend/src/components/VideoShowcase/VideoShowcase.jsx`, `frontend/src/hooks/useGeneration.js`, `frontend/src/styles/global.css`, `frontend/src/pages/Information.jsx`, `README.md`.

Добавлены: `backend/src/config/trends.js`, `backend/src/services/r2.service.js`, `backend/src/services/trend.service.js`, `backend/src/routes/trend.routes.js`, `backend/prisma/migrations/202610130001_trends_r2/migration.sql`, `backend/deploy/r2-cors.example.json`, этот документ, `backend/tests/trends.test.js`, `backend/scripts/run-database-checks.js`, `frontend/src/services/trendUploads.js`, `frontend/src/components/VideoShowcase/TrendDialog.jsx`, browser QA и его артефакты.

# Реальные генерации для ADMIN — 16.10.2026

> Актуальная логика: [DYNAMIC-PRICING.md](DYNAMIC-PRICING.md). Ограничение запуска только ADMIN снято для подтверждённых оплачиваемых заданий. ADMIN сохраняет нулевое списание и требует настроенную цену модели. Описание старого режима ниже историческое.

> Обновление 18.10.2026: [Pricing Engine v1](PRICING-ENGINE.md) требует корректную цену для нового задания, включая ADMIN. Освобождение ADMIN от списания сохранено; прежний обход ненастроенного тарифа больше не действует.

Обновление существующих Workflow, очереди и Higgsfield-адаптера. Новых API генерации нет. В production изменения и миграции автоматически не применялись; реальные платные генерации при разработке не запускались.

## Доступ и кредиты

Используется существующая роль в базе: `User.isAdmin = true` означает ADMIN. Она уже добавлена миграцией `202610130002_admin_access`. Второй enum ролей не нужен. JWT содержит ID пользователя; роль каждый раз читается из PostgreSQL. Frontend получает `isAdmin` от backend, email для проверки прав не используется.

Создание задачи проверяет ADMIN в сервисе, который используется как `/api/generations`, так и генерациями трендов. Проверка повторяется под блокировкой аккаунта в транзакции и перед первой отправкой воркером. Отзыв роли запрещает новые запросы; уже принятые провайдером задачи продолжают polling и сохраняют результат. Старые неотправленные задачи обычных пользователей завершаются без платной отправки с возвратом ранее списанной квоты.

Назначение роли выполняется из доверенной серверной консоли с подключением **к нужной production-базе**:

```sh
cd backend
npm run admin:access -- your-existing-email@example.com grant
```

В Render Shell, если Root Directory уже `backend`, команду `cd backend` пропустите. Подставьте email существующего аккаунта. Команда делает `update`, не создаёт аккаунт и не меняет его пароль или баланс. Для отзыва: `npm run admin:access -- your-existing-email@example.com revoke`. В браузере обновите страницу: `/api/auth/me` вернёт актуальную роль. Проверить настройку провайдера и R2 можно на существующей странице `/admin`.

ADMIN запускает задачи с `quotaCost = 0`, `adminTest = true`. Ненастроенный публичный тариф больше не блокирует ADMIN (`estimate.status = admin_test`). Для обычного пользователя создание возвращает `403 ADMIN_REQUIRED`, даже если у него положительный баланс. Прежние тарифы, транзакционное списание и возвраты сохранены для будущего публичного запуска; сейчас публичный запуск недоступен.

`Generation.costEstimate` сохраняет исходную ориентировочную оценку USD, количество изображений/секунд, ставку, источник, дату, `kind = estimate`, `baseCredits` (если тариф уже настроен) и `chargedCredits = 0`. Это справочная оценка по базовым ставкам, **не фактическое списание Higgsfield**: разрешение, звук, режим, скидки аккаунта могут менять цену. Ставки изображений взяты из §4.3 `HIGGSFIELD_API.md`, видео — из опубликованных начальных list rates семейства на [странице цен](https://open.higgsfield.ai/pricing). Для Motion Control используется базовая ставка семейства Kling 3.0, а не подтверждённая цена конкретного режима. Перед финансовым анализом уточните ставки в Console и обновите `referenceRates` в `pricing.service.js`. Для видео-референсов количество секунд читается из MP4 `mvhd`, а не придумывается или отправляется как неподдерживаемый `duration` в API.

**Отсутствие списания кредитов Betelgeuse не делает запрос бесплатным у Higgsfield.** Статус failed также не означает автоматически подтверждённое отсутствие расходов при потере ответа на отправку; сверяйте receipt/задачу в Console.

## Каталог и документация

Публичный `/api/models` и каталог сайта содержат только 11 MVP-моделей. Legacy ID `kling` сохранён, чтобы не ломать историю и тренды. Названия Grok Imagine 2.0 и Kling 2.5 Turbo Pro в provider reference соответствуют утверждённым Grok Image 2.0 и Kling 2.5 Turbo. Замены моделей не выполняются.

| Модель (internal ID) | Подготовленные режимы | Официальные API reference |
| --- | --- | --- |
| Qwen Image 3 (`qwen-image-3`) | Text to Image; Image to Image, 1–3 фото | [text-to-image](https://open.higgsfield.ai/models/alibaba/qwen-image-3/text-to-image/api-reference), [edit](https://open.higgsfield.ai/models/alibaba/qwen-image-3/edit/api-reference) |
| SOUL V2 (`soul-v2`) | Text to Image; Image to Image | [standard](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/standard/api-reference), [image-to-image](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/image-to-image/api-reference) |
| Ideogram 4.0 (`ideogram-4`) | Text to Image; Image to Image | [v4.0](https://open.higgsfield.ai/models/ideogram/v4.0/api-reference) |
| Recraft V4.1 (`recraft-v4-1`) | Text to Image | [text-to-image](https://open.higgsfield.ai/models/recraft/v4.1/text-to-image/api-reference) |
| Grok Image 2.0 (`grok-image-2`) | Text to Image; Image to Image | [grok-imagine-image-2.0](https://open.higgsfield.ai/models/xai/grok-imagine-image-2.0/api-reference) |
| Kling 2.5 Turbo (`kling-2-5-turbo`) | Text to Video; Image to Video | [pro/text-to-video](https://open.higgsfield.ai/models/kling-video/v2.5-turbo/pro/text-to-video/api-reference), [pro/image-to-video](https://open.higgsfield.ai/models/kling-video/v2.5-turbo/pro/image-to-video/api-reference) |
| Kling 3.0 Standard (`kling`) | Text to Video; Image to Video | [std/text-to-video](https://open.higgsfield.ai/models/kling-video/v3.0/std/text-to-video/api-reference), [std/image-to-video](https://open.higgsfield.ai/models/kling-video/v3.0/std/image-to-video/api-reference) |
| Wan 3.0 (`wan-3`) | Text to Video; Image to Video; First / Last Frame | [text-to-video](https://open.higgsfield.ai/models/alibaba/wan-3.0/text-to-video/api-reference), [image-to-video](https://open.higgsfield.ai/models/alibaba/wan-3.0/image-to-video/api-reference) |
| Kling O3 (`kling-o3`) | First / Last Frame; Video to Video | [first-last-frame](https://open.higgsfield.ai/models/kling-video/o3/first-last-frame/api-reference), [video-edit](https://open.higgsfield.ai/models/kling-video/o3/video-edit/api-reference) |
| Seedance 2.5 (`seedance-2-5`) | Text to Video; Image to Video; First / Last Frame | [text-to-video](https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference), [image-to-video](https://open.higgsfield.ai/models/bytedance/seedance-2.5/image-to-video/api-reference) |
| Kling 3.0 Motion Control (`kling-3-motion`) | Motion Control: фото + MP4 | [motion-control/std](https://open.higgsfield.ai/models/kling-video/v3/motion-control/std/api-reference) |

Endpoints и выбранный ограниченный набор параметров сверены с API reference 16.10.2026. Произвольные endpoint, URL референсов, параметры, стоимость и признаки ADMIN от клиента не принимаются. Доступ конкретного API-аккаунта к модели подтверждается только при её запуске пользователем; платный smoke test не выполнялся. Общие правила: [жизненный цикл](https://docs.higgsfield.ai/docs/concepts/requests), [ошибки](https://docs.higgsfield.ai/docs/concepts/errors).

## Хранение и восстановление

Существующие `/api/uploads` и `/api/uploads/references` проверяют содержимое файлов, нормализуют фотографии и при настроенном R2 сохраняют входы в приватный `references/<userId>/...`. Провайдер получает временные GET URL. Серверный POST генерации требует готовый R2, чтобы не отправлять платную задачу без настроенного хранилища результатов.

Воркер копирует видео в прежний `resultVideoKey`, изображения — в новый `resultImageKeys[]`. Результат считается completed после сохранения в R2. При ошибке R2 повторяются получение статуса и сохранение, генерация заново не отправляется. API на каждом чтении подписывает новые ссылки, поэтому история после обновления страницы не зависит от истечения старого signed URL. Файлы выдаются владельцу через прежние API и краткосрочные signed URL; bucket публичным делать не нужно.

Standard Workflow отображает статусы, ошибки, историю и реальные media URL. Используются прежние `MediaPreview`/`MaterialDialog`; изображения поддерживаются также на Canvas и в истории библиотеки. Вкладки библиотеки уточнены: «Генерации» и «Исходные изображения». Pro остаётся существующим редактором узлов; выполнение графа кнопкой Start в нём ранее не реализовано. Для отправки реальной генерации используйте Standard.

До POST клиента сохраняются body и idempotency key в sessionStorage. После потери ответа доступна ручная «Повторить проверку» с тем же ключом. Перезагрузка и polling сами POST не выполняют. Backend гарантирует уникальную задачу по `(userId, idempotencyKey)`, сравнивает смысл JSON независимо от порядка полей, сохраняет маркер отправки до платного POST и receipt после него. Если ответ на отправку потерян, автоматическая повторная платная отправка останавливается для сверки в Console. Проверки авторизации, CSRF, владения референсами, лимита активных задач и SSRF сохранены.

## Окружение

Новых обязательных переменных нет. Настройте на backend:

```dotenv
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...
JWT_SECRET=...
HIGGSFIELD_API_KEY_ID=...
HIGGSFIELD_API_KEY_SECRET=...
HIGGSFIELD_ENABLED=true
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=betelgeuse-uploads
R2_INPUT_URL_TTL_SECONDS=86400
PROVIDER_MEDIA_HOSTS=images.higgs.ai,videos.higgs.ai,cdn.higgsfield.ai
```

`PROVIDER_MEDIA_HOSTS` допускает только точные проверенные хосты media CDN. Если ваш аккаунт вернёт другой домен, добавьте проверенный hostname на backend. Ошибка неподдерживаемого CDN не запускает генерацию повторно. R2 API token должен разрешать чтение/запись объектов нужного bucket.

Сохраните прежнюю авторизацию и proxy: `NODE_ENV=production`, `CORS_ORIGINS=https://<frontend-domain>`, `FRONTEND_URL=https://<frontend-domain>`, `TRUST_PROXY=1`. При существующем Vercel same-origin proxy — `COOKIE_CROSS_SITE=false`. Секреты Higgsfield/R2 только на Render. Frontend: `VITE_API_URL=/api`, `BACKEND_ORIGIN=https://<render-service-domain>` (для `vercel.ts`). Не используйте `VITE_*` для секретов.

Очередь запускается существующим `server.js` вместе с backend. Сохранены `WORKER_INTERVAL_MS=5000`, `GENERATION_TIMEOUT_MS=1200000`, `MAX_ACTIVE_GENERATIONS=2`. На Render используйте сервис с постоянно работающим процессом для предсказуемого выполнения очереди; после остановки/перезапуска задачи восстанавливаются из PostgreSQL.

## Миграция и деплой

Нужна новая additive миграция `202610160002_admin_generations`: поля `resultImageKeys`, `adminTest`, `costEstimate`, а также `StoredImage.durationSeconds` для оценки MP4-референсов. Роль администратора не меняется. Прежние миграции также должны быть применены.

Render (Root Directory `backend`):

1. Build Command: `npm ci && npm run prisma:generate`.
2. Pre-Deploy Command: `npm run db:migrate`. Если отдельная pre-deploy команда недоступна, выполните миграцию в доверенной консоли перед запуском новой версии или добавьте её в конец build command.
3. Start Command: `npm start`.
4. Настройте окружение выше и назначьте существующему аккаунту ADMIN через `npm run admin:access -- EMAIL grant`.

Vercel (Root Directory `frontend`): `npm ci`, Build `npm run build`, Output `dist`. Задеплойте изменённые frontend-файлы и сохраните `/api` proxy в `vercel.ts`. Сначала примените миграции и обновите backend, затем frontend. В локальные `.env` реальные ключи не дописывались, флаги провайдера автоматически не включались, рабочая база не изменялась.

## Первая генерация вручную

1. Проверьте в Higgsfield Console действующие ключи и баланс провайдера.
2. Примените миграции, задеплойте сервисы, назначьте ADMIN существующему аккаунту.
3. Откройте свой обычный аккаунт Betelgeuse, обновите страницу и проверьте `/admin`: провайдер и R2 настроены.
4. Откройте `/workflow` → **Standard** → **Image** → **Text to Image** → **Qwen Image 3**. Оставьте `1k`, `1:1` и напишите, например, `A silver planet above a calm ocean, cinematic light`.
5. Нажмите **Generate** один раз. Это уже реальный платный запрос Higgsfield; внутренний баланс Betelgeuse останется прежним.
6. Дождитесь «В очереди» → «Создаётся» → «Готово», откройте изображение. После обновления страницы результат останется в Workflow и «Библиотека → Генерации».
7. Для первого видео выберите **Video → Text to Video → Kling 3.0 Standard → 5 сек**. Для Motion Control нужны фото и MP4; для First / Last Frame — оба кадра. Если отправка не подтверждена, используйте «Повторить проверку»; если backend требует сверки, проверьте задачу в Higgsfield до нового Generate.

## Проверки без расходов

Результат проверки 16.10.2026: backend **56/56** без пропусков, frontend **16/16**, production-сборка успешна; browser QA пройден. Восстановление после временного `429` также сохраняет исходный ключ неоднозначного запроса. Платных обращений не было. Существующее предупреждение сборки о `/images/hero.webp` к генерациям не относится.

```sh
cd backend
npm run prisma:generate
npm run test:db
cd ../frontend
npm test
npm run build
```

`test:db` создаёт отдельную временную PostgreSQL, применяет все миграции и удаляет кластер после завершения. Внешние HTTP и R2 в тестах генерации перехватываются. Покрыты все 11 моделей/все реализованные режимы, ADMIN с нулевым балансом, запрет обычного аккаунта с кредитами, отзыв роли, подмена роли клиентом, владение входами и результатами, идемпотентность, история, сохранение, скачивание видео, ошибки ключей/баланса/параметров/доступности, таймауты, сеть и повторное сохранение без платной отправки.

Browser QA: при запущенном Vite `node artifacts/admin-generations-browser-qa.mjs` из корня. Все API перехвачены. Проверяет ADMIN/обычного пользователя, статусы, media preview, восстановление после потери ответа, прежний ключ/body, отсутствие POST при reload/polling и мобильную ширину. Отчёт: `artifacts/admin-generations-browser-results.json`; скриншоты desktop/mobile рядом.

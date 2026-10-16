# Workflow Standard / Pro — реализация 16.10.2026

Standard и Professional работают на существующем `/workflow`. Переключатель находится справа в заголовке, не перезагружает страницу и сохраняет выбор отдельно для пользователя в localStorage. Оба компонента остаются смонтированными: переключение сохраняет промпты, файлы, настройки, позиции узлов и масштаб Canvas. После полной перезагрузки сохраняются выбор интерфейса, раскладка доски и отправленные запросы; локальные File и неотправленные промпты живут до ухода со страницы, как в прежнем Workflow.

Standard занимает примерно 33% рабочей ширины на desktop, остальная область содержит только нейтральный placeholder. На мобильных устройствах колонки идут последовательно, панель прокручивается. Список моделей, режимов, параметров и требований к референсам приходит с backend. Неподдерживаемые поля исключаются из отправляемого тела. Professional сохраняет прежний composer и его каталог; новые модели доступны в Standard.

## Подтверждённые модели

Официальные API reference проверены 16.10.2026. Все перечисленные ниже семейства подтверждены; доступность конкретному API-аккаунту без платного запроса не проверялась. Реальные платные генерации не выполнялись.

| Модель / internal ID | Реализованные режимы | Подтверждённые workflow ID и источники |
| --- | --- | --- |
| Qwen Image 3 / `qwen-image-3` | Text to Image, Image to Image, 1–3 упорядоченных референса | [`alibaba/qwen-image-3/text-to-image`](https://open.higgsfield.ai/models/alibaba/qwen-image-3/text-to-image/api-reference), [`alibaba/qwen-image-3/edit`](https://open.higgsfield.ai/models/alibaba/qwen-image-3/edit/api-reference) |
| SOUL V2 / `soul-v2` | Text to Image, Image to Image | [`higgsfield-ai/soul/v2/standard`](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/standard/api-reference), [`higgsfield-ai/soul/v2/image-to-image`](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/image-to-image/api-reference) |
| Ideogram 4.0 / `ideogram-4` | Text to Image, Image to Image | [`ideogram/v4.0`](https://open.higgsfield.ai/models/ideogram/v4.0/api-reference) |
| Recraft V4.1 / `recraft-v4-1` | Text to Image | [`recraft/v4.1/text-to-image`](https://open.higgsfield.ai/models/recraft/v4.1/text-to-image/api-reference) |
| Grok Imagine 2.0 / `grok-image-2` | Text to Image, Image to Image | [`xai/grok-imagine-image-2.0`](https://open.higgsfield.ai/models/xai/grok-imagine-image-2.0/api-reference) |
| Kling 2.5 Turbo Pro / `kling-2-5-turbo` | Text to Video, Image to Video | [`kling-video/v2.5-turbo/pro/text-to-video`](https://open.higgsfield.ai/models/kling-video/v2.5-turbo/pro/text-to-video/api-reference), [`kling-video/v2.5-turbo/pro/image-to-video`](https://open.higgsfield.ai/models/kling-video/v2.5-turbo/pro/image-to-video/api-reference) |
| Kling 3.0 Standard / прежний `kling` | Text to Video, Image to Video | [`kling-video/v3.0/std/text-to-video`](https://open.higgsfield.ai/models/kling-video/v3.0/std/text-to-video/api-reference), [`kling-video/v3.0/std/image-to-video`](https://open.higgsfield.ai/models/kling-video/v3.0/std/image-to-video/api-reference) |
| Wan 3.0 / `wan-3` | Text to Video, Image to Video, First / Last Frame | [`alibaba/wan-3.0/text-to-video`](https://open.higgsfield.ai/models/alibaba/wan-3.0/text-to-video/api-reference), [`alibaba/wan-3.0/image-to-video`](https://open.higgsfield.ai/models/alibaba/wan-3.0/image-to-video/api-reference) |
| Kling O3 / `kling-o3` | First / Last Frame, Video to Video | [`kling-video/o3/first-last-frame`](https://open.higgsfield.ai/models/kling-video/o3/first-last-frame/api-reference), [`kling-video/o3/video-edit`](https://open.higgsfield.ai/models/kling-video/o3/video-edit/api-reference) |
| Seedance 2.5 / `seedance-2-5` | Text to Video, Image to Video, First / Last Frame | [`bytedance/seedance-2.5/text-to-video`](https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference), [`bytedance/seedance-2.5/image-to-video`](https://open.higgsfield.ai/models/bytedance/seedance-2.5/image-to-video/api-reference) |
| Kling 3.0 Motion Control Standard / `kling-3-motion` | Motion Control: изображение + видео | [`kling-video/v3/motion-control/std`](https://open.higgsfield.ai/models/kling-video/v3/motion-control/std/api-reference) |

В задании «Grok Image 2.0» сопоставлен с официальным Grok Imagine 2.0. Для Kling 2.5 выбран подтверждённый вариант **Pro**; Standard-вариант не подменялся вымышленным путём. Прежние отключённые `higgsfield` (Seedance 2.0) и `veo` сохранены.

Реализация предоставляет проверенное подмножество возможностей API. В частности, Recraft не получает вымышленный Image to Image. Для Grok установлен внутренний предел одного референса; он не объявляется максимальной возможностью провайдера. SOUL генерирует по одному изображению; создание Soul ID не реализовано. Дополнительные необязательные функции — multi-shot, обучение персонажа, arbitrary seed, палитры и маски — не включены.

У Kling 3.0 сохранены прежние длительности 5/10 секунд и настройки Professional. У новых Wan и Seedance используются подтверждённые диапазоны 2–30 и 4–30 секунд. У Motion Control и O3 Video Edit отсутствуют неподдерживаемые поля duration/resolution/aspect ratio. O3 Video Edit передаёт `video_urls`, Motion Control — `video_url`. First / Last Frame в интерфейсе требует два разных изображения.

## API

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/models` | Расширенный существующий каталог, включая workflow ID, тип, режимы, ограничения, defaults, pricingStatus и доступность |
| `GET /api/models/:id` | Возможности конкретной модели |
| `POST /api/generations/estimate` | Серверный расчёт: `configured/unconfigured`, credits, baseCredits, sufficientBalance, providerAvailable |
| `POST /api/generations` | Расширенный существующий маршрут создания задания; обязателен UUID-заголовок `Idempotency-Key` |
| `GET /api/generations/:id` | Прежний маршрут статуса; добавлены generationType и resultImageUrls |
| `GET /api/generations` | Прежняя история с пагинацией |
| `POST /api/uploads/references` | Multipart-поле `file`: изображение или MP4 |
| `GET /api/uploads/:id` | Прежний приватный маршрут чтения; поддерживает также MP4 |

Создание принимает `model`, `mode`, `prompt`, поддерживаемые `duration`, `quality`, `aspectRatio`, `parameters` и `references: [{role, uploadId}]`. Расчёт стоимости принимает те же настройки без prompt/references. Для старого Professional сохранён `sourceImageId`. Произвольные цены, provider URL и дополнительные поля отклоняются.

Для новых маршрутов сохранены сессия, CSRF, CORS, общий rate limit и проверка владельца. Каталог публичный, остальные операции требуют авторизации. Локальные изображения нормализуются через sharp и ограничены 10 МБ; MP4 проверяется по фактическому типу и ограничен 50 МБ. Видео хранится в существующей таблице StoredImage для совместимости, не попадает в список исходных изображений. Ключи API остаются на сервере. URL провайдера доступны только после разрешения принадлежащих пользователю upload ID.

Загрузка через `POST /files/generate-upload-url` и последующий PUT использует прежний адаптер; поддержка `video/mp4` подтверждена в [официальном описании загрузки файлов](https://docs.higgsfield.ai/docs/concepts/file-uploads). Авторизационный заголовок Higgsfield не отправляется на адрес хранилища.

## Кредиты и ошибки

Вся политика — `backend/src/config/modelPricing.js`, расчёт — `pricing.service.js`. Прежняя квота Kling: 5 секунд = 1 кредит, 10 секунд = 2 кредита. Это внутренние кредиты Betelgeuse, а не USD-цены Higgsfield. Новые десять моделей имеют `status: 'unconfigured'`; генерация блокируется, включая административный аккаунт.

Для включения тарифа задайте `status: 'configured'` и `rules: [{match: {...}, credits: ...}]` с утверждённым целым неотрицательным количеством кредитов. Match поддерживает `mode`, `duration`, `quality`, `aspectRatio` и `parameters.<name>`. Например, для Grok учитывайте отдельно resolution (`quality` в Betelgeuse) и детализацию (`parameters.quality`). Для тарифов, зависящих от настроек, перечисляйте все влияющие поля. Если совпадает ноль или несколько правил, статус расчёта — `unconfigured`. Фиксированная цена для всех значений допустима только как сознательно утверждённая политика продукта.

Backend пересчитывает стоимость при создании. Прежний административный доступ даёт нулевое списание только для настроенного тарифа. Баланс и роль проверяются под блокировкой аккаунта в существующей транзакции; недостаточный баланс или чужой референс откатывают операцию. Unique(userId, idempotencyKey) и payloadHash исключают повторное списание, в том числе при конкурентных запросах. Повтор принятого запроса возвращает прежнюю задачу даже после отключения её тарифа.

Существующий worker обрабатывает Image и Video. Подтверждённые failed/nsfw/canceled возвращают квоту однократно. Отказ до отправки тоже освобождает кредиты. Для всех моделей сохраняется submissionAttemptedAt: неоднозначная отправка или перезапуск после отправки без receipt останавливают задачу для сверки с провайдером. Без подтверждения отказа кредиты не возвращаются автоматически. После получения receipt повторяются только polling/получение результата. Автоматическое повторное создание платной задачи отключено.

## Настройка и миграция

Новые переменные окружения не добавлены. Нужны существующие:

- `DATABASE_URL`, `DIRECT_URL` — приложение и миграции PostgreSQL.
- `JWT_SECRET`, `CORS_ORIGINS`, `FRONTEND_URL`, `COOKIE_CROSS_SITE`, `TRUST_PROXY` — прежняя авторизация и размещение.
- `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, `HIGGSFIELD_ENABLED=true` — включение провайдера после настройки тарифов.
- `PROVIDER_MEDIA_HOSTS` — точные разрешённые хосты входных/выходных файлов провайдера. При новом CDN добавляйте только проверенный hostname.
- `MAX_ACTIVE_GENERATIONS`, `WORKER_INTERVAL_MS`, `GENERATION_TIMEOUT_MS` — прежние настройки очереди.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_INPUT_URL_TTL_SECONDS` — для существующего R2-потока трендов; Standard может загружать референсы через локальное хранилище и Higgsfield Files API.
- Frontend: `VITE_API_URL=/api`; для Vercel proxy — существующий `BACKEND_ORIGIN`. `API_PROXY_TARGET` применяется только локально.

Миграция `202610160001_workflow_models` добавляет новые значения GenerationMode, generationType, parameters, references и resultImageUrls. Она проверена на отдельной временной PostgreSQL. Рабочая/удалённая база и хостинг не изменялись.

```powershell
cd backend
npm run prisma:generate
npm run db:migrate
npm start
```

Перед включением новых платных генераций заполните утверждённые тарифы. Секреты в `VITE_*` не передаются. На хостинге с непостоянным диском используйте прежний R2-поток либо подключите постоянное хранилище для локальных загрузок.

## Изменённые файлы

Созданы:

- `frontend/src/components/Workspace/StandardWorkflow.jsx` — новый интерфейс.
- `frontend/src/components/Workspace/ProfessionalWorkflow.jsx` — выделенный прежний Workflow.
- `frontend/src/services/workflow-options.js` — фильтрация и допустимые настройки.
- `frontend/tests/workflow-options.test.js` — проверки настроек и референсов.
- `backend/src/config/workflowModels.js` — проверенные API-конфигурации.
- `backend/src/config/modelPricing.js` — политика кредитов.
- `backend/src/services/model-validation.service.js`, `pricing.service.js` — общая валидация и расчёт.
- `backend/prisma/migrations/202610160001_workflow_models/migration.sql` — расширение существующей очереди.
- `backend/tests/workflow-models.test.js`, `server.test.js` — новые проверки.
- `artifacts/workflow-redesign-qa.mjs` — браузерная проверка с заглушками API.
- `artifacts/workflow-redesign-1440.png`, `workflow-redesign-390.png` — снимки интерфейса с тестовыми данными.
- `backend/deploy/WORKFLOW-REDESIGN.md` — этот отчёт.

Изменены:

- `frontend/src/pages/WorkflowPage.jsx` — общий переключатель, загрузка каталога и сохранение выбора.
- `frontend/src/hooks/useWorkflowGenerations.js` — независимое восстановление запроса Standard.
- `frontend/src/styles/workflow.css` — Standard, переключатели и адаптивность.
- `backend/src/config/models.js`, `trends.js` — единый каталог и источник стоимости.
- `backend/src/services/generation.service.js`, `higgsfield.service.js`, `storage.service.js` — расширение прежних сервисов.
- `backend/src/jobs/generation.worker.js` — Image-результаты, референсы и безопасная обработка неоднозначной отправки.
- `backend/src/controllers/generation.controller.js`, `upload.controller.js`, `workspace.controller.js` — расчёт, загрузка, исключение видео из списка изображений.
- `backend/src/routes/generation.routes.js`, `upload.routes.js`, `app.js` — расширенные API.
- `backend/src/middleware/errors.js` — сообщение лимита загрузки для обоих типов медиа.
- `backend/prisma/schema.prisma` — новые поля и режимы Generation.
- `backend/tests/database.test.js` — проверка остановки неоднозначной отправки вместо повторного запуска.
- `backend/scripts/run-database-checks.js` — надёжное завершение и удаление временного кластера на Windows.
- `README.md`, `HIGGSFIELD_API.md` — актуальная настройка и примечание о расхождениях справочника.

## Проверки и дальнейшая работа

- Backend: `npm run test:db` — **52/52 прошли, без пропусков**: изолированная PostgreSQL, применение всех миграций, unit/integration проверки, запуск реального HTTP-сервера с выключенным провайдером.
- Frontend: `npm test` — 13 проверок, включая фильтрацию каталога и удаление неподдерживаемых настроек.
- Frontend: `npm run build` — production-сборка. Существующее предупреждение о `/images/hero.webp` относится к отсутствующему статическому ресурсу.
- Browser: `node artifacts/workflow-redesign-qa.mjs` при запущенном Vite на 127.0.0.1:5173 — переключение, независимые промпты/файлы, сохранение узлов и viewport, динамические режимы, ограничения референсов, блокировка unconfigured, повтор с прежним ключом и сохранение выбранного интерфейса. Проверены ширины 320, 390, 768, 1024 и 1440 px; переполнения и JavaScript-ошибок нет. Все API в этой проверке перехвачены заглушками.

Для запуска новых моделей остаётся утвердить кредиты, применить миграцию к целевой базе и включить/проверить доступ своего Higgsfield-аккаунта. Платная проверка адаптеров требует отдельного разрешения. Правая область Standard намеренно не содержит результатов и анимации. Image-задачи возвращают resultImageUrls через API; их отдельная галерея и долгосрочное копирование результатов в R2 оставлены для следующего этапа. Прежняя библиотека продолжает показывать исходные изображения и историю задач; полноценный показ результатов новых Image-моделей в ней не добавлялся.

# Pricing Engine v1 — реализация и деплой

> Актуальные наценки, подписки и подтверждение стоимости: [DYNAMIC-PRICING.md](DYNAMIC-PRICING.md). Стандартная наценка теперь 80%; обычные пользователи могут запускать задания с достаточным балансом. Примеры ниже описывают предыдущую версию.

> Текущая оптимизация v1.1: [PRICING-OPTIMIZATION.md](PRICING-OPTIMIZATION.md). Измерение aspectRatio удалено, кроме документированного исключения Seedance. Для Seedance действует billingReviewRequired до проверки token billing.

Реализованы 11 подключённых моделей, 22 режима и 124 пустых ценовых ячеек. Полный каталог с workflow, параметрами, комбинациями и инструкцией: [BETELGEUSE_MODELS.md](../../BETELGEUSE_MODELS.md).

## Поведение

Единственный источник стоимости для frontend — backend. Кредиты рассчитываются с наценкой 40% и ценой кредита $0.01: `ceil(providerCostUSD × 1.40 / 0.01)`. Десятичная арифметика использует целые коэффициенты BigInt и рациональное деление; округление выполняется один раз в самом конце.

Изображение: ставка всего запроса. Видео: ставка USD за секунду × длительность. Для Video Edit/Motion Control длительность берётся из принадлежащего пользователю проверенного MP4. Если в реальном тарифе действуют другие правила времени или пакетной выдачи, оставьте ячейку `null` до реализации этих правил. Числовые цены не заполнены и не скопированы из справочников.

Пустая, некорректная или неподдерживаемая конфигурация возвращает `PRICE_UNAVAILABLE`, `credits: null`. Запуск блокируется в UI и при создании задания, включая ADMIN. Исключение ADMIN из списания и существующее ограничение доступа только ADMIN сохранены. Новых платежей и покупок кредитов нет.

Оценка API показывает розничную цену `credits` и отдельно фактическое `chargedCredits`. У ADMIN второе равно 0 только при известной цене. Публичные ответы не содержат `costEstimate`, `providerCostUSD`, `retailUSD`, наценку и цену кредита.

При создании цена и версия фиксируются в существующем `Generation.costEstimate`; `quotaCost` остаётся фактическим списанием и источником суммы возврата. Версия включает hash всего тарифа, policy и возможностей моделей. История и idempotent-повторы читают snapshot и не переоценивают задания. Worker и логика возврата кредитов не изменялись. Старые записи без версии не получают выдуманного тарифа: показывается сохранённое списание, если оно известно.

## Созданные файлы

- `BETELGEUSE_MODELS.md` — каталог и инструкция ручного заполнения ставок.
- `backend/src/config/modelCatalog.js` — существующие определения моделей вынесены из публичного представления без смены workflow.
- `backend/src/pricing/providers/higgsfield.json` — только подключённые модели и реальные выбираемые конфигурации; все 124 ставок `null`.
- `backend/src/pricing/pricing-policy.js` — наценка, стоимость кредита, округление.
- `backend/src/pricing/pricing-engine.js` — расчёт, проверка конфигураций, версия, публичное представление и минимум каталога.
- `backend/test-support/mock-pricing.js` — исключительно тестовые ставки в памяти, без записи в JSON.
- `backend/tests/pricing-engine.test.js` — арифметика, ошибки, параметры, единицы, версии, минимальные цены.
- `backend/tests/pricing-api.test.js` — публичный контракт, блокировка запуска, собственность референсов, неизменность цены и версии.
- `backend/deploy/PRICING-ENGINE.md` — этот отчёт.
- `frontend/src/services/pricing.js` — отображение цены, минимума и сохранённого списания.
- `frontend/src/hooks/useGenerationPrice.js` — backend-оценка с отменой устаревших запросов.
- `frontend/tests/pricing.test.js` — отображение неизвестных цен, минимума и стоимости истории.
- `artifacts/pricing-ui-qa.mjs` — браузерная проверка UI с перехваченными API, без настоящих генераций.

## Изменённые файлы

- Backend: `src/config/models.js`, `src/config/trends.js`, `src/services/model-validation.service.js`, `src/services/pricing.service.js`, `src/services/generation.service.js`, `src/controllers/generation.controller.js`.
- Backend regression tests: `tests/admin-generations.test.js`, `tests/admin.test.js`, `tests/database.test.js`, `tests/security.test.js`, `tests/trends.test.js`, `tests/workflow-models.test.js`, `tests/workspace.test.js` — синтетические цены задаются только в памяти тестового процесса; прежние ожидания ненастроенного ADMIN-тарифа обновлены.
- Frontend catalog: `src/components/AIModels/AIModels.jsx`, `AIModels.css`, `src/components/Workspace/ModelCarousel.jsx`, `professional-workflow.css`.
- Frontend generation: `src/components/Workspace/StandardWorkflow.jsx`, `PromptComposer.jsx`, `WorkflowNode.jsx`, `src/components/Generator/Generator.jsx`, `src/components/VideoShowcase/VideoModal.jsx`.
- Frontend history: `src/components/Workspace/InteractiveCanvas.jsx`, `MaterialDialog.jsx`, `src/pages/Library.jsx`.
- Переводы RU/EN/KK: `frontend/src/i18n/locales/{ru,en,kk}.json`.
- `backend/deploy/ADMIN-GENERATIONS.md` — ссылка на новые обязательные правила тарифа.

Удалён `backend/src/config/modelPricing.js` с прежними фиксированными внутренними ценами Kling. Все рабочие потребители переведены на Pricing Engine. Существующие API-ключи, секреты и пользовательские изменения в showcase-media не изменялись.

## API

`POST /api/generations/estimate` требует действующую сессию и CSRF. Получает те же model/mode/options, что генерация, без prompt; для цены входного видео принимает только `references: [{role, uploadId}]`. Длительность файла, USD и кредиты от клиента не принимаются.

Успешная оценка:

```json
{
  "status": "AVAILABLE",
  "credits": 7,
  "tariffVersion": "higgsfield-v1:<hash>",
  "chargedCredits": 0,
  "adminTest": true,
  "providerAvailable": true,
  "storageAvailable": true,
  "sufficientBalance": true,
  "canGenerate": true
}
```

Это пример ответа на синтетический тестовый тариф, а не цена подключённой модели. При неизвестной цене: `status: PRICE_UNAVAILABLE`, `credits: null`, `tariffVersion: null`, `chargedCredits: null`, `canGenerate: false`.

`GET /api/models` и `GET /api/models/:id` содержат `pricing` с `kind: fixed | from | null`. «От» — минимум среди настроенных комбинаций, не обещание доступности любой конфигурации. Режимы, которым нужна неизвестная длительность входного видео, не участвуют в выдумывании минимума.

Создание без цены: HTTP 400 с `code: PRICE_UNAVAILABLE`. Неподдерживаемые модельные параметры оценки возвращают `PRICE_UNAVAILABLE`; структурно некорректный запрос по-прежнему отклоняется обычной schema validation. Отсутствующая сессия, запрещённая роль и чужой референс сохраняют существующие HTTP-ошибки доступа.

## Тестирование

Результат проверки 18.10.2026: **66/66 backend-тестов на отдельном PostgreSQL, без пропусков; 25/25 frontend-тестов; production-сборка успешна**. Браузерная проверка подтвердила блокировку неизвестной цены, обновление оценки после смены разрешения, защиту от устаревшей оценки, сохранённую цену истории, каталог Pro, mobile и ADMIN; ошибок JavaScript нет, настоящих запросов генерации нет. В сборке остаётся предупреждение о ранее существующей ссылке `/images/hero.webp`, не разрешённой на этапе build.

- `cd backend && npm run test:db`: полный набор с миграциями в отдельном временном PostgreSQL; никаких запросов к реальной базе разработки или production.
- `cd frontend && npm test`: frontend-тесты, включая форматирование стоимости.
- `cd frontend && npm run build`: production-сборка.
- При запущенном frontend: `node artifacts/pricing-ui-qa.mjs` из корня. API и данные тестовые, настройки тарифного JSON не меняются.

Проверки покрывают наценку 40%, изменение стоимости кредита, точный ceil на десятичной границе, null/0/некорректные цены, несовместимые параметры, серверную длительность MP4, запрет цены от клиента, блокировку запуска при null, сохранение snapshot при изменении и удалении тарифа, повтор с тем же idempotency key, отсутствие утечек через каталог/оценку/списки/историю.

## Миграции и настройки деплоя

1. Новых таблиц, колонок и миграций нет. Проверена существующая Prisma-схема: `Generation.costEstimate Json`, `quotaCost Int` и `StoredImage.durationSeconds Float?` уже существуют. На окружении должны быть применены прежние миграции, включая `202610160002_admin_generations`.
2. Включите JSON в backend deploy artifact. Дополнительных npm-зависимостей и переменных окружения нет; ключи Higgsfield/R2 остаются прежними.
3. Вручную заполните подтверждённые ставки по инструкции BETELGEUSE_MODELS.md; неизвестные оставьте `null`. Изменяйте policy централизованно в `pricing-policy.js`, при очень малых дробях используйте десятичные строки.
4. Выполните обычный deploy/restart backend: JSON читается один раз на процесс. Одновременно обновите frontend под новый контракт `pricing`; прежние `creditCosts` и публичный `costEstimate` удалены.
5. При деплое с текущим JSON все новые генерации будут заблокированы до ручного заполнения ставок, включая ADMIN. Уже созданные задания продолжат обработку с сохранённой стоимостью.

Реальная оплата, покупка кредитов, платёжные webhook и платные вызовы Higgsfield не выполнялись.

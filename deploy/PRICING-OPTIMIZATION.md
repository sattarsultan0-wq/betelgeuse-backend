# Pricing Engine v1.1 — оптимизация и аудит

Дата: 18.10.2026. Итог: **595 → 124 ячейки**, сокращение на 471 (79,2%). Все ставки production JSON остаются `null`. Сохраняются 11 моделей, 22 режима и прежние workflow.

## Почему итог не 94

Удаление всех осей `aspectRatio` дало бы 94 ячейки. При проверке единиц обнаружилось документированное исключение: [Seedance 2.5 Image-to-Video](https://open.higgsfield.ai/models/bytedance/seedance-2.5/image-to-video/playground) описывает расчёт по video tokens и реальным размерам результата; показанная ставка за секунду — приближение для конкретного формата. Поэтому нельзя считать этот тариф одинаковым для всех размеров.

У Seedance TEXT_TO_VIDEO консервативно сохранена исходная ось `aspectRatio` (36 ячеек вместо 6). Это вывод по подтверждённому I2V-контуру семейства, а не заявление о прочитанной полной таблице цен T2V: его прямую страницу тарифа повторно прочитать не удалось. IMAGE_TO_VIDEO и FIRST_LAST_FRAME не предоставляют выбора aspect ratio в текущей интеграции; их параметры и 6 ячеек на режим сохранены. Это даёт 48 ячеек Seedance и 124 всего. Список поддерживаемых форматов и workflow не менялся.

Во всех трёх режимах Seedance добавлено `billingReviewRequired: true`: engine возвращает `PRICE_UNAVAILABLE` даже при случайно заполненной ставке. Сама единица `second` сохранена для совместимости структуры, но не объявляется точной моделью token billing. Снятие флага допустимо только после реализации и проверки точной формулы либо подтверждения договорной линейной посекундной ставки для всех поддерживаемых комбинаций.

Предложение для будущего token-тарифа, **не реализовано этим рефакторингом**:

```text
unit: video_token_1000
dimensions: разрешение + подтверждённые платные параметры
цена: USD за 1000 video tokens
quantity: ceil(outputWidth × outputHeight × billableSeconds × fps / 1024) / 1000
```

Нужны подтверждённые размеры каждого результата, правила их определения по референсу, FPS, время, тарифицируемое до рендера, и точность округления провайдера. Переданные браузером width/height не могут считаться доверенными. Одна только ось aspect ratio не решает эту задачу. Публичные workflow не заменялись, расчёт по неизвестным размерам не придумывался.

## Таблица сокращения

| Модель / internal ID | Было | Стало | Измерения новой ставки |
| --- | ---: | ---: | --- |
| Kling 3.0 Standard / `kling` | 4 | 2 | `quality` |
| Qwen Image 3 / `qwen-image-3` | 40 | 4 | `quality` |
| SOUL V2 / `soul-v2` | 28 | 4 | `quality` |
| Ideogram 4.0 / `ideogram-4` | 138 | 6 | `parameters.rendering_speed` |
| Recraft V4.1 / `recraft-v4-1` | 14 | 1 | `quality` |
| Grok Imagine 2.0 / `grok-image-2` | 80 | 8 | `quality`, `parameters.quality` |
| Kling 2.5 Turbo Pro / `kling-2-5-turbo` | 2 | 2 | Нет, отдельная ставка на режим |
| Wan 3.0 / `wan-3` | 216 | 36 | `quality`, `generate_audio`, `enable_thinking` |
| Seedance 2.5 / `seedance-2-5` | 48 | 48 | `quality`, `generate_audio`, в T2V также `aspectRatio`; review required |
| Kling O3 / `kling-o3` | 21 | 9 | `mode`, в FIRST_LAST_FRAME также `sound` |
| Kling 3.0 Motion Control / `kling-3-motion` | 4 | 4 | `keep_original_sound`, `character_orientation` |
| **Всего** | **595** | **124** | |

Режимы всегда независимы. Длительность для подтверждённых посекундных workflow учитывается множителем после выбора ставки, а не копированием JSON для каждой секунды.

## Аудит параметров и источники

Ставки из интернета не переносились в JSON. Источники ниже подтверждают единицы или наличие API-полей; это не проверка invoice конкретного аккаунта.

| Параметр | Что удалось установить | Решение |
| --- | --- | --- |
| Aspect ratio, кроме Seedance | В просмотренных pricing-описаниях нет отдельной доплаты за выбранный формат при том же разрешении. Это отсутствие подтверждения доплаты, а не гарантия любого API-контракта. | По заданной политике Betelgeuse исключён из ставки, остаётся в валидации и payload. |
| Wan `enable_thinking` | [API reference](https://open.higgsfield.ai/models/alibaba/wan-3.0/text-to-video/api-reference) подтверждает boolean. [Pricing T2V](https://open.higgsfield.ai/models/alibaba/wan-3.0/text-to-video/playground) задаёт ставку по разрешению, но отдельно не описывает стоимость thinking. | Измерение сохранено как резерв для проверяемой конфигурации. Не объявлено платной доплатой. |
| Wan `generate_audio` | Поле поддерживается, отдельная доплата в приведённом описании не выделена. | Сохранено; заполнять одинаковыми ставками только при подтверждении аккаунта. |
| Motion `keep_original_sound`, `character_orientation` | [API reference](https://open.higgsfield.ai/models/kling-video/v3/motion-control/std/api-reference) подтверждает оба поля. [Pricing](https://open.higgsfield.ai/models/kling-video/v3/motion-control/std/playground) публикует посекундную цену без отдельной разбивки по этим полям. | Четыре ячейки сохранены; отдельная доплата не утверждается. |
| Grok `quality` и `parameters.quality` | [API reference](https://open.higgsfield.ai/models/xai/grok-imagine-image-2.0/api-reference): API `resolution` и API `quality` — разные поля. В Betelgeuse они отображаются как `quality` и `parameters.quality`. [Pricing](https://open.higgsfield.ai/models/xai/grok-imagine-image-2.0/playground) приводит комбинации разрешения и детализации, но не полную независимую матрицу. | Оба измерения сохранены, неизвестные комбинации не выводятся из соседней цены. |
| Ideogram `rendering_speed` | [API reference](https://open.higgsfield.ai/models/ideogram/v4.0/api-reference) содержит DEFAULT/TURBO/QUALITY. [Pricing](https://open.higgsfield.ai/models/ideogram/v4.0/playground) показывает цену изображения без полной разбивки по скорости. | Три ставки на режим сохранены по заданию; влияние скорости отдельно не подтверждено. |
| Kling O3 `mode`, `sound` | [API reference](https://open.higgsfield.ai/models/kling-video/o3/first-last-frame/api-reference) подтверждает std/pro/4k и sound. Общий диапазон цены не даёт точной ставки каждой комбинации. | Сохранены все комбинации. |
| Seedance `generate_audio` | Поле поддерживается. Отдельную доплату за audio нельзя вывести из опубликованной token-формулы. | Измерение сохранено; все режимы остаются на billing review. |

Неопределённые параметры не удалены ради числа 94. Наличие отдельной ячейки означает возможность отдельно подтвердить ставку; это не правило о том, что параметр обязательно увеличивает цену.

## Проверка единиц каждого подключённого workflow

У image-workflow цена опубликована за изображение; сохраняем `generation` при текущей фиксированной одиночной выдаче. У SOUL `batch_size: 1` уже зафиксирован. Если будет добавлен batch, понадобится явное количество результатов и соответствующая цена; новый batch не добавлен.

| Workflow | Проверенный источник единицы | Решение |
| --- | --- | --- |
| `alibaba/qwen-image-3/text-to-image` | [Pricing](https://open.higgsfield.ai/models/alibaba/qwen-image-3/text-to-image/playground), per image | `generation` |
| `alibaba/qwen-image-3/edit` | [Pricing](https://open.higgsfield.ai/models/alibaba/qwen-image-3/edit/playground), per image | `generation` |
| `higgsfield-ai/soul/v2/standard` | [Pricing](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/standard/playground), per image | `generation`, batch 1 |
| `higgsfield-ai/soul/v2/image-to-image` | [Pricing](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/image-to-image/playground), per image | `generation`, batch 1 |
| `ideogram/v4.0` — T2I и I2I | [Pricing](https://open.higgsfield.ai/models/ideogram/v4.0/playground), per image | `generation` |
| `recraft/v4.1/text-to-image` | [Pricing](https://open.higgsfield.ai/models/recraft/v4.1/text-to-image/playground), per image | `generation` |
| `xai/grok-imagine-image-2.0` — T2I и I2I | [Pricing](https://open.higgsfield.ai/models/xai/grok-imagine-image-2.0/playground), per image | `generation` |
| `kling-video/v3.0/std/text-to-video` | [Pricing](https://open.higgsfield.ai/models/kling-video/v3.0/std/text-to-video/playground), per second | `second` |
| `kling-video/v3.0/std/image-to-video` | [Pricing](https://open.higgsfield.ai/models/kling-video/v3.0/std/image-to-video/playground), per second | `second` |
| `kling-video/v2.5-turbo/pro/text-to-video` | [Pricing](https://open.higgsfield.ai/models/kling-video/v2.5-turbo/pro/text-to-video/playground), per second, 5/10 — поддерживаемая длительность | `second`, пакеты не подтверждены |
| `kling-video/v2.5-turbo/pro/image-to-video` | [Pricing](https://open.higgsfield.ai/models/kling-video/v2.5-turbo/pro/image-to-video/playground), per second | `second` |
| `alibaba/wan-3.0/text-to-video` | [Pricing](https://open.higgsfield.ai/models/alibaba/wan-3.0/text-to-video/playground), per generated second | `second` |
| `alibaba/wan-3.0/image-to-video` — I2V и FIRST_LAST_FRAME | [Pricing](https://open.higgsfield.ai/models/alibaba/wan-3.0/image-to-video/playground), per generated second | `second` |
| `bytedance/seedance-2.5/text-to-video` | Страница T2V недоступна при повторной проверке; [каталог](https://open.higgsfield.ai/pricing) показывает ориентир /s, но соседний подключённый I2V явно описывает token billing | `second` только как прежний шаблон, billing review |
| `bytedance/seedance-2.5/image-to-video` — I2V и FIRST_LAST_FRAME | [Pricing](https://open.higgsfield.ai/models/bytedance/seedance-2.5/image-to-video/playground), video tokens, зависит от output dimensions | `second` только как прежний шаблон, billing review |
| `kling-video/o3/first-last-frame` | [Pricing](https://open.higgsfield.ai/models/kling-video/o3/first-last-frame/playground), per second | `second`; рекламная разбивка не заменяет проверку std/pro/4k и длительности |
| `kling-video/o3/video-edit` | [Pricing](https://open.higgsfield.ai/models/kling-video/o3/video-edit/playground), per second | `second`, длительность проверенного видео |
| `kling-video/v3/motion-control/std` | [Pricing](https://open.higgsfield.ai/models/kling-video/v3/motion-control/std/playground), per second | `second`, длительность проверенного видео |

Подтверждения фиксированного пакета за 5 или 10 секунд для подключённого Kling 2.5 Turbo Pro не найдено: документ описывает посекундную ставку. Если договор аккаунта предусматривает пакет, предложенная будущая структура — `unit: generation`, дополнительная ценовая ось `duration`, отдельные цены 5/10. Сейчас такая структура и смена единицы не внедрены.

## Что изменено

- `backend/src/pricing/providers/higgsfield.json`: 124 null-ячейки, версия `higgsfield-v1.1`, удалены несущественные оси формата; Seedance сохранён и отмечен billing review.
- `backend/src/pricing/pricing-engine.js`: обновлена строгая проверка измерений и обход минимумов; одинаковые форматы не порождают повторных расчётов. Добавлен запрет на непроверенный тип тарификации.
- `backend/tests/pricing-engine.test.js`: равенство форматов, разные resolution/mode/параметры, посекундное масштабирование, 124 ячейки, отказ старой структуры и защита Seedance.
- `backend/tests/pricing-api.test.js`: параллельные оценки, исторический v1 snapshot, приватность и прежние проверки идемпотентности.
- `backend/test-support/mock-pricing.js`: lifecycle-тесты адаптеров используют явно синтетическую посекундную ставку, временно снимая review-флаг **только в памяти тестового процесса**. Это не проверка реального token billing.
- `BETELGEUSE_MODELS.md`: параметры, workflow, единицы, таблица до/после и пример пути заполнения для каждой модели.
- `backend/deploy/PRICING-ENGINE.md`: ссылка на текущий аудит и актуальное число ячеек.
- `backend/deploy/PRICING-OPTIMIZATION.md`: этот отчёт.
- `artifacts/pricing-ui-qa.mjs`: новый JSON, смена формата, устаревшие параллельные оценки, Pro-параметры и библиотека.
- `artifacts/update-pricing-optimization-docs.mjs`, `artifacts/pricing-optimization-baseline.json`: вспомогательный пересчёт документации и контроль исходной структуры/хешей; не входят в runtime.

Frontend runtime и дизайн не менялись: компоненты уже запрашивают оценку backend при изменении любых параметров. Валидация моделей, исходные caps, payload Higgsfield, списание/возврат, генерационный сервис, Prisma-схема и worker сохраняются без изменений. Старый snapshot читается как записан, а не проходит повторную проверку против новой структуры JSON. Миграции и изменения production-базы не нужны.

## Как заполнить JSON

1. Выберите модель и режим, подтвердите тариф API-аккаунта и единицу по источникам выше.
2. Следуйте порядку `dimensions` до конечного `null`. Например, `models["qwen-image-3"].TEXT_TO_IMAGE.prices["1k"]` теперь задаёт одну ставку для всех допустимых форматов, а `models["ideogram-4"].TEXT_TO_IMAGE.prices.QUALITY` — отдельную ставку скорости.
3. Введите положительную десятичную строку USD: за запрос для `generation`, за секунду для `second`. Числа в тестовых fixtures не являются тарифами. Не заполняйте непроверенные комбинации; `null` сохраняет `PRICE_UNAVAILABLE`.
4. Для параметров с неопределённым влиянием подтвердите, одинакова ли ставка, и только затем заполните соответствующие ячейки. Не выводите её из другой модели или режима.
5. **Seedance пока не заполнять и не снимать `billingReviewRequired` вручную ради запуска.** Сначала требуется точная схема token billing или подтверждение совместимого договорного тарифа.
6. Обновите version и перезапустите backend. В frontend ничего заполнять не нужно. Старые задания сохраняют цену и tariffVersion.

## Проверки

- Backend: `npm run test:db` — **74/74**, без пропусков. Временный отдельный PostgreSQL, все семь прежних миграций применены только там; production и база разработки не использовались.
- Frontend: `npm test` — **25/25**.
- Production: `npm run build` — успешно. Остаётся прежнее предупреждение о `/images/hero.webp`; к рефакторингу тарифа не относится.
- Browser: `node artifacts/pricing-ui-qa.mjs` — успешно, **0 отправок генерации, 0 ошибок JavaScript**. Проверены каталог, Standard/Pro, обновление цены resolution и равенство aspect ratio, опоздавший ответ старого запроса, Generate при неизвестной цене, ADMIN, mobile, карточки и библиотека с сохранённой ценой.
- Backend API: шесть параллельных оценок с разными duration/aspect ratio, null на неподдерживаемой комбинации, приватность каждого ответа. Историческая версия v1 сохраняется независимо от нового JSON; idempotent-повторы и стоимость записанного задания проверены.

Платные генерации, настоящие API-ключи и production-база не использовались. Проверка контрольных хешей подтверждает сохранность policy, model caps, model validation, Higgsfield adapter, generation service/controller, Prisma schema и worker относительно начала этого задания.

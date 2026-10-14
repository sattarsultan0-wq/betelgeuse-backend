# Supabase и Render

## Результат миграции 14 октября 2026

Prisma и Prisma Client сохранены на версии **6.19.0**. Обе строки подключения проверены: один проект Supabase, база и схема `public`. Перед миграцией схема была пустой. `prisma migrate deploy` успешно применил все пять существующих миграций.

Созданы 8 таблиц приложения (`User`, `Generation`, `StoredImage`, `Plan`, `Subscription`, `AuthIdentity`, `OAuthAttempt`, `DirectUpload`) и служебная `_prisma_migrations`. Проверены 25 индексов приложения, 7 внешних ключей, 4 CHECK-ограничения и 4 enum. Prisma Client сгенерирован, `migrate status` сообщает актуальную схему, `migrate diff` не обнаружил расхождений.

Express проверен в production-режиме локальным HTTP-запросом: `/api/health` вернул 200 и `database: connected`. Prisma прочитал все восемь таблиц; приватные API без сессии вернули 401. Проверка не запускала worker и не записывала данные. Все 34 database-теста прошли на отдельном временном локальном PostgreSQL. Существующая локальная база не удалялась и не сбрасывалась.

## Подключения Prisma 6

В `prisma/schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

`DATABASE_URL` используется приложением: Supabase transaction pooler на порту 6543 с `pgbouncer=true`. `DIRECT_URL` используется Prisma Migrate: session pooler на порту 5432 без `pgbouncer=true`. Session pooler подходит для IPv4; прямой адрес `db.PROJECT_REF.supabase.co:5432` требует доступного IPv6 либо IPv4 add-on. В обеих строках включён `sslmode=require`. Пароль должен быть URL-encoded; копируй точные параметры из Supabase Connect.

Документация: [Prisma 6 datasource](https://www.prisma.io/docs/orm/v6/reference/prisma-schema-reference), [подключения Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).

`.env.example` содержит только шаблоны. `.env` и его варианты исключены правилами `.gitignore`, а `.env.example` разрешён. В рабочей папке нет Git-метаданных, поэтому фактический индекс и историю удалённого репозитория проверить нельзя. Секреты загружай в Render через Environment, не через файлы репозитория.

При переключении обратно на локальный PostgreSQL замени **обе** строки подключения на локальные. Тестовый runner задаёт обе строки для временной базы, чтобы тестовые миграции не использовали Supabase.

## Настройки Render

Создай Node Web Service с Root Directory `backend` и Node.js 22.12 или новее (локальная проверка выполнена на Node.js 24).

| Настройка | Значение |
| --- | --- |
| Build Command | `npm ci --include=dev && npm run prisma:generate` |
| Start Command | `npm run db:migrate && npm start` |
| Health Check Path | `/api/health` |

Prisma CLI — dev dependency, поэтому она должна быть установлена для генерации клиента и миграций. Клиент генерируется на Render для Linux; Windows `node_modules` переносить не нужно. `migrate deploy` пропускает уже применённые миграции. На платном сервисе можно вынести `npm run db:migrate` в Pre-Deploy Command и оставить Start Command `npm start`.

Существующий сервер слушает `0.0.0.0` и использует `PORT` из окружения Render. Вручную фиксировать `PORT=4000` не требуется. См. [Render Express](https://render.com/docs/deploy-node-express-app) и [Pre-Deploy Command](https://render.com/docs/deploys#pre-deploy-command).

Перенеси в Render следующие значения окружения:

- `DATABASE_URL`, `DIRECT_URL` — проверенные строки Supabase.
- `NODE_ENV=production`.
- `JWT_SECRET` — постоянный случайный секрет длиной минимум 32 символа.
- `CORS_ORIGINS` — точный HTTPS origin frontend, без пути; несколько origin разделяются запятыми.
- `FRONTEND_URL=https://betelgeuse-ai.vercel.app` — разрешённый origin возврата из OAuth; подробности API и Google Cloud в [RENDER-VERCEL.md](RENDER-VERCEL.md).
- `TRUST_PROXY=1` — для прокси Render.
- `COOKIE_CROSS_SITE=true`, если frontend и API находятся на разных сайтах, например Vercel и `onrender.com`. Для собственных поддоменов одного сайта настройку выбирай по фактической схеме размещения.
- Существующие серверные параметры OAuth, R2 и провайдера генерации — по нужным функциям, из `.env.example`; не передавай их в frontend.

Деплой на Render в рамках этой задачи не выполнялся. Проверено подключение локального Express к Supabase, а не сетевой доступ из ещё не созданного Render-сервиса.

## Supabase Data API перед публичным запуском

Проверка выявила фактические права `anon`/`authenticated` на таблицы приложения при выключенном RLS. Проверка сессии Express защищает его маршруты, но не отдельный Supabase Data API. Права и политики в этой задаче не изменялись.

Этот backend работает напрямую через Prisma и не использует Supabase REST/GraphQL. Для такого размещения отключи **Enable Data API** в Dashboard → Data API integration. Это убирает доступ через автоматически созданные REST endpoints и сохраняет PostgreSQL-подключение Prisma. Если Data API нужен другим клиентам, вместо отключения отдельно настрой права и RLS перед публичным запуском. [Инструкция Supabase](https://supabase.com/docs/guides/api/securing-your-api#disable-the-data-api).

## Повторная проверка без записи данных

Из каталога `backend`:

```powershell
node scripts/check-supabase-db.js --verify
node scripts/check-supabase-app.js
node node_modules/prisma/build/index.js migrate status
```

Скрипты не выводят строки подключения, пароли или пользовательские записи. Проверка приложения использует временный HTTPS CORS origin только внутри своего процесса. `--preflight` предназначен исключительно для новой пустой базы: на уже мигрированной базе он намеренно сообщает конфликт. Не добавляй его в запуск Render.

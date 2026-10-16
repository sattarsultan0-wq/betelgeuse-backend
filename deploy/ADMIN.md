> ?????????? ?????? 11 ???????: [ADMIN-GENERATIONS.md](ADMIN-GENERATIONS.md). ???????? ??????? ????????? ?????? ADMIN.

# Доступ администратора

Аккаунту `sattarsultan0@gmail.com` назначена роль администратора в локальной БД. Имя Sultan не используется как признак доступа: любой новый аккаунт получает `isAdmin: false`.

Страница `/admin` доступна из шапки через иконку щита. Она использует существующий генератор, показывает состояние конфигурации Higgsfield/R2 и ссылки на тренды и историю.

Новые генерации администратора, включая тренды, не списывают кредиты Betelgeuse: в Generation сохраняется `quotaCost: 0`. Ошибки таких задач не начисляют кредиты. Это не отменяет оплату Higgsfield с баланса API-аккаунта и не включает API автоматически. Ключи, HIGGSFIELD_ENABLED и промпты должны быть настроены как раньше. Реальные запросы при реализации не отправлялись.

Авторизация, проверка фотографий, rate limiting, лимит активных задач, idempotency и защита от повторных платных запросов остаются общими. Backend читает роль из БД при каждом создании задачи и обращении к `GET /api/admin/status`; роль не принимается от клиента и не хранится в JWT.

При переносе на другую БД выполните в backend:

```powershell
npm run prisma:generate
npm run db:migrate
npm run admin:access -- sattarsultan0@gmail.com grant
```

Аккаунт должен уже существовать. Команда не создаёт пользователя и не меняет пароль. Для снятия доступа:

```powershell
npm run admin:access -- sattarsultan0@gmail.com revoke
```

Обновите страницу, чтобы интерфейс получил актуальную роль. Сервер применяет отзыв сразу, включая запросы с ранее выданной cookie.

Изменены схема User и ограничение стоимости Generation (теперь неотрицательное), сервисы авторизации/генераций, worker, app, package.json, frontend App/Header/Generator/TrendDialog/Library и стили. Добавлены миграция `202610130002_admin_access`, middleware/admin.js, routes/admin.routes.js, scripts/admin-access.js, tests/admin.test.js и pages/Admin.jsx.
# Актуализация: генерации ADMIN

Актуальный порядок включения 11 моделей, хранения в R2 и деплоя: [ADMIN-GENERATIONS.md](ADMIN-GENERATIONS.md). Прежние инструкции назначения `isAdmin` сохраняются; реальные запросы теперь разрешены только ADMIN.

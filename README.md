# Боты записи для ветклиники (Cloudflare Workers + D1)

Два Telegram-бота на одном Worker'е и одной базе:

| Бот | Для кого | Что делает |
|---|---|---|
| **Клиентский** (`/tg/client`) | клиенты | приветствие с логотипом, затем имя → телефон → выбор своего питомца или добавление нового (вид, кличка, пол, возраст) → описание проблемы → врач → дата → время → подтверждение; «🐾 Мои питомцы» (список, добавление, удаление); «Мои записи» с отменой; напоминание накануне в 18:00 |
| **Админский** (`/tg/admin`) | администраторы | мгновенное уведомление о новой записи и отмене; «📝 Записать клиента» вручную (по телефону или на ресепшене); «Сегодня», «Завтра», «Неделя»; сводка на сегодня в 08:00 и итоги дня в 20:00; закрытие и открытие времени; отмена любой записи |

Виды питомцев задаются в `src/index.js`, константа `PETS`. Новый вид добавляется одной строкой.

Расписание: 10:00–18:00, слоты по 30 минут (последний в 17:30). Всё меняется в `wrangler.toml`.
Записи через бота закрывают слот автоматически. Администратор вручную закрывает слоты, занятые по телефону, перерыв или выходной врача (🔒), и может закрыть весь день одной кнопкой.

## Запуск через GitHub и панель Cloudflare (без командной строки)

1. **@BotFather**: `/newbot` два раза (клиентский и админский бот), сохранить оба токена.
2. **Cloudflare → Storage & Databases → D1 → Create database**, имя `vet-lazaret-db`.
   - Скопировать **Database ID** и вписать в `wrangler.toml` вместо `ВСТАВЬТЕ_ID_...`.
   - Открыть базу → вкладка **Console** → вставить всё содержимое `schema.sql` → **Execute**.
3. **Workers & Pages → Create → Import a repository** → выбрать этот репозиторий.
   - Build command: пусто. Deploy command: `npx wrangler deploy`.
4. **Worker → Settings → Variables and Secrets → Add** (тип *Secret*):
   - `CLIENT_BOT_TOKEN` — токен клиентского бота
   - `ADMIN_BOT_TOKEN` — токен админского бота
   - `WEBHOOK_SECRET` — любая длинная строка (латиница, цифры, `_`, `-`)
   - `ADMIN_IDS` — пока `0`, позже Telegram ID админов через запятую
5. Открыть в браузере `https://<адрес-воркера>/setup?key=<WEBHOOK_SECRET>`. Должно быть `"ok": true` для обоих ботов.
6. Написать `/start` админскому боту, он покажет ваш Telegram ID. Вписать его в секрет `ADMIN_IDS`.

Каждый push в репозиторий автоматически пересобирает и деплоит бота.

## Запуск через командную строку (альтернатива)

```bash
npm i
npx wrangler login
npx wrangler d1 create vet-lazaret-db        # id → wrangler.toml
npx wrangler d1 execute vet-lazaret-db --remote --file=schema.sql
npx wrangler secret put CLIENT_BOT_TOKEN     # и ADMIN_BOT_TOKEN, WEBHOOK_SECRET, ADMIN_IDS
npx wrangler deploy
```

## Как менять врачей

Врачи хранятся в таблице `doctors`. Примеры:
```bash
wrangler d1 execute vet-lazaret-db --remote --command \
  "UPDATE doctors SET name='Новое ФИО', specialty='Терапевт', description='...' WHERE id=1"
wrangler d1 execute vet-lazaret-db --remote --command \
  "INSERT INTO doctors (name, specialty, description, sort) VALUES ('ФИО', 'Кардиолог', '...', 5)"
wrangler d1 execute vet-lazaret-db --remote --command "UPDATE doctors SET active=0 WHERE id=4"   # скрыть врача
```

## Логотип

- В приветствии: впишите прямую ссылку на картинку в `LOGO_URL`.
- Аватарка ботов: в @BotFather → `/setuserpic`.

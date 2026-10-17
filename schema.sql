-- Схема базы данных (Cloudflare D1)

CREATE TABLE IF NOT EXISTS doctors (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  specialty   TEXT NOT NULL,
  description TEXT DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,   -- 0 = скрыт от клиентов
  deleted     INTEGER NOT NULL DEFAULT 0,   -- 1 = удалён (история записей сохраняется)
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id    INTEGER NOT NULL,
  date         TEXT NOT NULL,          -- YYYY-MM-DD
  time         TEXT NOT NULL,          -- HH:MM
  client_tg_id INTEGER,                -- пусто, если записал администратор
  client_name  TEXT NOT NULL,
  phone        TEXT NOT NULL,
  pet          TEXT,                   -- вид: cat | dog
  pet_id       INTEGER,                -- питомец из профиля клиента
  pet_name     TEXT,                   -- кличка (копия на момент записи)
  pet_sex      TEXT,                   -- m | f
  pet_age      TEXT,
  problem      TEXT,                   -- описание проблемы
  source       TEXT NOT NULL DEFAULT 'bot',     -- bot | admin
  status       TEXT NOT NULL DEFAULT 'active',  -- active | cancelled
  cancelled_by TEXT,                   -- client | admin
  reminded     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Один слот у врача может быть занят только одной активной записью
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_slot
  ON bookings(doctor_id, date, time) WHERE status = 'active';

-- Время, закрытое администратором вручную (записи по телефону, перерыв и т.п.)
CREATE TABLE IF NOT EXISTS blocks (
  doctor_id  INTEGER NOT NULL,
  date       TEXT NOT NULL,
  time       TEXT NOT NULL,
  created_by INTEGER,
  PRIMARY KEY (doctor_id, date, time)
);

-- Сохранённые данные клиента, чтобы не спрашивать имя и телефон каждый раз
CREATE TABLE IF NOT EXISTS clients (
  tg_id INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  phone TEXT NOT NULL
);

-- Питомцы клиентов («🐾 Мои питомцы»)
CREATE TABLE IF NOT EXISTS pets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL,        -- Telegram ID владельца
  kind       TEXT NOT NULL,           -- cat | dog
  name       TEXT NOT NULL,
  sex        TEXT NOT NULL,           -- m | f
  age        TEXT NOT NULL,           -- свободный текст: «3 года», «5 месяцев»
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pets_owner ON pets(owner_id, active);

-- Администраторы, вошедшие по паролю (pw_hash — отпечаток пароля на момент входа;
-- после смены пароля старые входы перестают действовать)
CREATE TABLE IF NOT EXISTS admins (
  tg_id      INTEGER PRIMARY KEY,
  username   TEXT,
  name       TEXT,
  pw_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Состояние диалога (на каком шаге пользователь)
CREATE TABLE IF NOT EXISTS sessions (
  bot        TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  state      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot, user_id)
);

-- Тестовые врачи (потом заменим на настоящих)
INSERT OR IGNORE INTO doctors (id, name, specialty, description, sort) VALUES
  (1, 'Иванова Ивана Ивановна',   'Терапевт',        'Первичный приём, вакцинация, профилактические осмотры', 1),
  (2, 'Петров Пётр Петрович',     'Хирург',          'Операции, стерилизация, обработка ран',                 2),
  (3, 'Сидорова Анна Сергеевна',  'Дерматолог',      'Кожные заболевания, аллергии, проблемы с шерстью',      3),
  (4, 'Козлов Дмитрий Андреевич', 'УЗИ-диагностика', 'УЗИ брюшной полости и сердца',                          4);

// Два Telegram-бота для ветклиники на одном Cloudflare Worker + D1.
//   /tg/client — бот для клиентов (запись к врачу)
//   /tg/admin  — бот для администратора (уведомления, сводки, закрытие времени)

// ───────────────────────── Утилиты ─────────────────────────

const WD = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const weekday = (s) => { const w = new Date(s + 'T00:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
const fmtDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return `${WD[weekday(s)]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const shortDate = (s) => { const d = new Date(s + 'T00:00:00Z'); return `${WD[weekday(s)]} ${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const hhmm = (t) => t.replace(':', '');
const unhhmm = (t) => `${t.slice(0, 2)}:${t.slice(2, 4)}`;

function nowLocal(env) {
  const off = Number(env.TZ_OFFSET_MIN ?? 180); // Липецк = Москва = UTC+3
  return new Date(Date.now() + off * 60000);
}
const today = (env) => ymd(nowLocal(env));
const nowMinutes = (env) => { const d = nowLocal(env); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

function slotTimes(env) {
  const start = toMin(env.WORK_START || '10:00');
  const end = toMin(env.WORK_END || '18:00');
  const step = Number(env.SLOT_MINUTES || 30);
  const out = [];
  for (let m = start; m + step <= end; m += step) out.push(fromMin(m));
  return out;
}
const workDays = (env) => String(env.WORK_DAYS || '1,2,3,4,5,6,7').split(',').map(Number);

function upcomingDates(env) {
  const n = Number(env.DAYS_AHEAD || 14);
  const wd = workDays(env);
  const t = today(env);
  const out = [];
  for (let i = 0; i < n; i++) { const d = addDays(t, i); if (wd.includes(weekday(d))) out.push(d); }
  return out;
}

function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length < 10 || d.length > 15) return null;
  return '+' + d;
}
function fmtPhone(p) {
  const d = String(p).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '7') return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  return p;
}
// Виды питомцев. Чтобы добавить новый — допишите строку, например: rabbit: '🐰 Кролик'
const PETS = { cat: '🐱 Кошка', dog: '🐶 Собака' };
const petLabel = (p) => PETS[p] || p || '';
const petKb = (prefix) => ik(chunk(Object.entries(PETS).map(([k, v]) => ({ text: v, callback_data: `${prefix}:${k}` })), 2));
const MAX_PROBLEM = 500;

const adminIds = (env) => String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const isAdmin = (env, id) => adminIds(env).includes(String(id));

// ───────────────────────── Telegram API ─────────────────────────

// Режим одного бота: если ADMIN_BOT_TOKEN не задан, админ-панель живёт в клиентском боте
// и открывается только у тех, чей Telegram ID указан в ADMIN_IDS.
const singleBot = (env) => !env.ADMIN_BOT_TOKEN || env.ADMIN_BOT_TOKEN === env.CLIENT_BOT_TOKEN;

async function tg(env, bot, method, payload) {
  const token = bot === 'client' || singleBot(env) ? env.CLIENT_BOT_TOKEN : env.ADMIN_BOT_TOKEN;
  const base = env.TG_API_BASE || 'https://api.telegram.org';
  try {
    const r = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok && !String(j.description || '').includes('not modified')) console.log('TG error', method, j.description);
    return j;
  } catch (e) {
    console.log('TG fetch failed', method, String(e));
    return { ok: false };
  }
}
const send = (env, bot, chat_id, text, reply_markup) =>
  tg(env, bot, 'sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup, disable_web_page_preview: true });
const edit = (env, bot, msg, text, reply_markup) =>
  tg(env, bot, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML', reply_markup });
const ik = (rows) => ({ inline_keyboard: rows });
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// ───────────────────────── База данных ─────────────────────────

async function getSession(env, bot, uid) {
  const r = await env.DB.prepare('SELECT state, data FROM sessions WHERE bot=? AND user_id=?').bind(bot, uid).first();
  return { state: r?.state || '', data: r ? JSON.parse(r.data || '{}') : {} };
}
async function setSession(env, bot, uid, state, data = {}) {
  await env.DB.prepare(
    `INSERT INTO sessions (bot, user_id, state, data, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(bot, user_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at`
  ).bind(bot, uid, state, JSON.stringify(data)).run();
}
const getDoctors = async (env) =>
  (await env.DB.prepare('SELECT * FROM doctors WHERE active=1 ORDER BY sort, id').all()).results;
const getDoctor = (env, id) => env.DB.prepare('SELECT * FROM doctors WHERE id=?').bind(id).first();

// Статус каждого слота врача на дату: free | booked | blocked | past
async function slotMap(env, doctorId, date) {
  const [b, bl] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM bookings WHERE doctor_id=? AND date=? AND status='active'").bind(doctorId, date),
    env.DB.prepare('SELECT time FROM blocks WHERE doctor_id=? AND date=?').bind(doctorId, date),
  ]);
  const booked = new Map(b.results.map((r) => [r.time, r]));
  const blocked = new Set(bl.results.map((r) => r.time));
  const isToday = date === today(env);
  const now = nowMinutes(env);
  const map = {};
  for (const t of slotTimes(env)) {
    if (booked.has(t)) map[t] = { state: 'booked', booking: booked.get(t) };
    else if (isToday && toMin(t) <= now) map[t] = { state: 'past' };
    else if (blocked.has(t)) map[t] = { state: 'blocked' };
    else map[t] = { state: 'free' };
  }
  return map;
}

// Даты, на которые у врача есть хотя бы одно свободное окно
async function freeDates(env, doctorId) {
  const dates = upcomingDates(env);
  if (!dates.length) return [];
  const from = dates[0], to = dates[dates.length - 1];
  const [b, bl] = await env.DB.batch([
    env.DB.prepare("SELECT date, time FROM bookings WHERE doctor_id=? AND date BETWEEN ? AND ? AND status='active'").bind(doctorId, from, to),
    env.DB.prepare('SELECT date, time FROM blocks WHERE doctor_id=? AND date BETWEEN ? AND ?').bind(doctorId, from, to),
  ]);
  const taken = new Set([...b.results, ...bl.results].map((r) => r.date + ' ' + r.time));
  const t = today(env), now = nowMinutes(env), slots = slotTimes(env);
  return dates.filter((d) => slots.some((s) => !taken.has(d + ' ' + s) && !(d === t && toMin(s) <= now)));
}

// ───────────────────────── Бот для клиентов ─────────────────────────

const CLIENT_MENU = {
  keyboard: [[{ text: '📅 Записаться на приём' }], [{ text: '🐾 Мои питомцы' }, { text: '📋 Мои записи' }]],
  resize_keyboard: true,
};

function clinicFooter(env) {
  const parts = [];
  if (env.CLINIC_ADDRESS) parts.push(`📍 ${esc(env.CLINIC_ADDRESS)}`);
  if (env.CLINIC_PHONE) parts.push(`☎️ ${esc(env.CLINIC_PHONE)}`);
  return parts.length ? '\n\n' + parts.join('\n') : '';
}

async function clientWelcome(env, chatId) {
  const caption =
    `🐾 <b>${esc(env.CLINIC_NAME || 'Ветеринарная клиника')}</b>\n\n` +
    `Здравствуйте! Здесь можно записаться на приём к врачу в пару нажатий.\n\n` +
    `Нажмите «📅 Записаться на приём».` + clinicFooter(env);
  if (env.LOGO_URL) {
    const r = await tg(env, 'client', 'sendPhoto', { chat_id: chatId, photo: env.LOGO_URL, caption, parse_mode: 'HTML', reply_markup: CLIENT_MENU });
    if (r.ok) return;
  }
  await send(env, 'client', chatId, caption, CLIENT_MENU);
}

async function doctorListView(env) {
  const docs = await getDoctors(env);
  let text = '🩺 <b>Выберите врача:</b>\n';
  for (const d of docs) {
    text += `\n<b>${esc(d.name)}</b> — ${esc(d.specialty)}`;
    if (d.description) text += `\n<i>${esc(d.description)}</i>`;
    text += '\n';
  }
  const rows = docs.map((d) => [{ text: `${d.name} · ${d.specialty}`, callback_data: `doc:${d.id}` }]);
  return { text, kb: ik(rows) };
}

async function dateView(env, doctorId) {
  const doc = await getDoctor(env, doctorId);
  if (!doc) return { text: 'Врач не найден.', kb: ik([[{ text: '◀️ К списку врачей', callback_data: 'docs' }]]) };
  const dates = await freeDates(env, doctorId);
  let text = `🩺 <b>${esc(doc.name)}</b>\n${esc(doc.specialty)}`;
  if (doc.description) text += `\n<i>${esc(doc.description)}</i>`;
  const rows = chunk(dates.map((d) => ({ text: shortDate(d), callback_data: `date:${doctorId}:${d}` })), 3);
  text += dates.length ? '\n\n📅 <b>Выберите дату:</b>' : '\n\n😔 Свободного времени на ближайшие дни нет. Выберите другого врача или позвоните в клинику.';
  rows.push([{ text: '◀️ К списку врачей', callback_data: 'docs' }]);
  return { text, kb: ik(rows) };
}

async function timeView(env, doctorId, date) {
  const doc = await getDoctor(env, doctorId);
  const map = await slotMap(env, doctorId, date);
  const free = Object.keys(map).filter((t) => map[t].state === 'free');
  let text = `🩺 <b>${esc(doc?.name)}</b>\n📅 ${fmtDate(date)}\n\n`;
  text += free.length ? '🕐 <b>Выберите время:</b>' : '😔 На эту дату всё занято. Выберите другую дату.';
  const rows = chunk(free.map((t) => ({ text: t, callback_data: `time:${doctorId}:${date}:${hhmm(t)}` })), 4);
  rows.push([{ text: '◀️ К выбору даты', callback_data: `doc:${doctorId}` }]);
  return { text, kb: ik(rows) };
}

async function startBooking(env, uid, chatId) {
  const c = await env.DB.prepare('SELECT name, phone FROM clients WHERE tg_id=?').bind(uid).first();
  if (c) {
    await setSession(env, 'client', uid, 'known', { name: c.name, phone: c.phone });
    await send(env, 'client', chatId,
      `Записать на ваши данные?\n\n👤 <b>${esc(c.name)}</b>\n📞 ${fmtPhone(c.phone)}`,
      ik([[{ text: '✅ Да, продолжить', callback_data: 'me:yes' }], [{ text: '✏️ Изменить данные', callback_data: 'me:edit' }]]));
    return;
  }
  await setSession(env, 'client', uid, 'ask_name', {});
  await send(env, 'client', chatId, '👤 Как вас зовут? Напишите имя.', { remove_keyboard: true });
}

async function askPhone(env, chatId, name) {
  await send(env, 'client', chatId,
    `Приятно познакомиться, ${esc(name)}!\n\n📞 Отправьте номер телефона: нажмите кнопку ниже или напишите номер сообщением.`,
    { keyboard: [[{ text: '📱 Отправить мой номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });
}

async function myBookings(env, uid, chatId) {
  const t = today(env);
  const rows = (await env.DB.prepare(
    `SELECT b.*, d.name AS doctor_name, d.specialty FROM bookings b JOIN doctors d ON d.id=b.doctor_id
     WHERE b.client_tg_id=? AND b.status='active' AND b.date>=? ORDER BY b.date, b.time`
  ).bind(uid, t).all()).results;
  if (!rows.length) {
    await send(env, 'client', chatId, 'У вас нет предстоящих записей.', CLIENT_MENU);
    return;
  }
  for (const b of rows) {
    await send(env, 'client', chatId,
      `🩺 <b>${esc(b.doctor_name)}</b> (${esc(b.specialty)})\n📅 ${fmtDate(b.date)}\n🕐 ${b.time}`,
      ik([[{ text: '❌ Отменить запись', callback_data: `cancel:${b.id}` }]]));
  }
}

async function notifyAdmins(env, text, kb) {
  for (const id of adminIds(env)) await send(env, 'admin', id, text, kb);
}

const SEX = { m: 'мальчик', f: 'девочка' };
const MAX_PETS = 10;
// «Мурка — 🐱 Кошка, девочка, 3 года»
function petLine(p) {
  const kind = p.pet ?? p.kind, name = p.pet_name ?? p.name, sex = p.pet_sex ?? p.sex, age = p.pet_age ?? p.age;
  if (!name) return petLabel(kind);
  return [`${name} — ${petLabel(kind)}`, SEX[sex], age].filter(Boolean).join(', ');
}
const petSnapshot = (p) => ({ pet_id: p.id, pet: p.kind, pet_name: p.name, pet_sex: p.sex, pet_age: p.age });
const getPets = async (env, uid) =>
  (await env.DB.prepare('SELECT * FROM pets WHERE owner_id=? AND active=1 ORDER BY id').bind(uid).all()).results;
const getPet = (env, uid, id) => env.DB.prepare('SELECT * FROM pets WHERE id=? AND owner_id=? AND active=1').bind(id, uid).first();

async function petsListView(env, uid) {
  const pets = await getPets(env, uid);
  const add = [{ text: '➕ Добавить питомца', callback_data: 'addpet:p' }];
  if (!pets.length) return { text: '🐾 <b>Мои питомцы</b>\n\nУ вас пока нет питомцев. Добавьте питомца — и при записи к врачу останется только выбрать его.', kb: ik([add]) };
  const text = '🐾 <b>Мои питомцы</b>\n\n' + pets.map((p) => `• ${esc(petLine(p))}`).join('\n') + '\n\nНажмите на питомца, чтобы открыть карточку.';
  const rows = pets.map((p) => [{ text: `${petLabel(p.kind).split(' ')[0]} ${p.name}`, callback_data: `pv:${p.id}` }]);
  if (pets.length < MAX_PETS) rows.push(add);
  return { text, kb: ik(rows) };
}

// Шаг «питомец» при записи: выбрать своего или добавить нового
async function choosePetStep(env, uid, chatId, msg, data) {
  const pets = await getPets(env, uid);
  let text, kb;
  if (!pets.length) {
    await setSession(env, 'client', uid, 'pet_kind', { ...data, after: 'booking' });
    text = '🐾 У вас пока нет питомцев — давайте добавим.\n\n<b>Кто ваш питомец?</b>';
    kb = petKb('pk');
  } else {
    await setSession(env, 'client', uid, 'ask_pet', data);
    text = '🐾 <b>Для кого запись?</b>\n\nВыберите питомца или добавьте нового.';
    const rows = pets.map((p) => [{ text: `${petLabel(p.kind).split(' ')[0]} ${p.name}`, callback_data: `bp:${p.id}` }]);
    if (pets.length < MAX_PETS) rows.push([{ text: '➕ Добавить питомца', callback_data: 'addpet:b' }]);
    kb = ik(rows);
  }
  return msg ? edit(env, 'client', msg, text, kb) : send(env, 'client', chatId, text, kb);
}

function detailsText(b, doc) {
  let t = `👤 ${esc(b.client_name)}\n📞 ${fmtPhone(b.phone)}`;
  if (b.pet) t += `\n🐾 ${esc(petLine(b))}`;
  if (b.problem) t += `\n📝 ${esc(b.problem)}`;
  t += `\n🩺 ${esc(doc?.name)} (${esc(doc?.specialty)})\n📅 ${fmtDate(b.date)}\n🕐 ${b.time}`;
  return t;
}

async function bookingCard(env, b, title) {
  const doc = await getDoctor(env, b.doctor_id);
  let t = `${title}\n\n${detailsText(b, doc)}`;
  if (b.source === 'admin') t += '\n\n<i>Записал администратор</i>';
  return t;
}

// Шаги анкеты: питомец → проблема → врач
async function askPet(env, bot, chatId, msgToEdit) {
  const text = bot === 'client' ? '🐾 Кто ваш питомец?' : '🐾 Питомец клиента?';
  if (msgToEdit) return edit(env, bot, msgToEdit, text, petKb(bot === 'client' ? 'pet' : 'apet'));
  return send(env, bot, chatId, text, petKb(bot === 'client' ? 'pet' : 'apet'));
}
async function askProblem(env, bot, chatId) {
  return send(env, bot, chatId,
    `📝 Опишите проблему коротко: что беспокоит, сколько длится. Например: «плохо ест третий день» или «плановая прививка».`,
    ik([[{ text: 'Пропустить ➡️', callback_data: bot === 'client' ? 'prob:skip' : 'aprob:skip' }]]));
}

async function handleClient(env, u) {
  const from = u.message?.from || u.callback_query?.from;
  if (u.message && (u.message.text || '').trim() === '/id') {
    return send(env, 'client', u.message.chat.id, `Ваш Telegram ID: <code>${from.id}</code>`);
  }
  // В режиме одного бота администраторы попадают в админ-панель
  if (from && singleBot(env) && isAdmin(env, from.id)) return handleAdmin(env, u);
  if (u.message) {
    const m = u.message, uid = m.from.id, chatId = m.chat.id;
    const text = (m.text || '').trim();
    if (text === '/start' || text === '🏠 Главное меню') {
      await setSession(env, 'client', uid, '', {});
      return clientWelcome(env, chatId);
    }
    if (text === '📅 Записаться на приём' || text === '/book') return startBooking(env, uid, chatId);
    if (text === '📋 Мои записи' || text === '/my') return myBookings(env, uid, chatId);
    if (text === '🐾 Мои питомцы' || text === '/pets') {
      await setSession(env, 'client', uid, '', {});
      const v = await petsListView(env, uid);
      return send(env, 'client', chatId, v.text, v.kb);
    }

    const s = await getSession(env, 'client', uid);
    if (s.state === 'pet_name') {
      if (text.length < 1 || text.length > 30 || text.startsWith('/')) return send(env, 'client', chatId, 'Напишите кличку (до 30 символов).');
      await setSession(env, 'client', uid, 'pet_sex', { ...s.data, newPet: { ...s.data.newPet, name: text } });
      return send(env, 'client', chatId, `<b>${esc(text)}</b> — мальчик или девочка?`,
        ik([[{ text: '♂️ Мальчик', callback_data: 'ps:m' }, { text: '♀️ Девочка', callback_data: 'ps:f' }]]));
    }
    if (s.state === 'pet_age') {
      if (text.length < 1 || text.length > 20 || text.startsWith('/')) return send(env, 'client', chatId, 'Напишите возраст, например: «3 года» или «5 месяцев».');
      const np = { ...s.data.newPet, age: text };
      const r = await env.DB.prepare('INSERT INTO pets (owner_id, kind, name, sex, age) VALUES (?, ?, ?, ?, ?) RETURNING *')
        .bind(uid, np.kind, np.name, np.sex, np.age).first();
      const { newPet, after, ...rest } = s.data;
      if (after === 'booking') {
        await setSession(env, 'client', uid, 'ask_problem', { ...rest, ...petSnapshot(r) });
        await send(env, 'client', chatId, `✅ Питомец добавлен!\n\n🐾 Запись для: <b>${esc(petLine(r))}</b>`);
        return askProblem(env, 'client', chatId);
      }
      await setSession(env, 'client', uid, '', {});
      await send(env, 'client', chatId, `✅ Питомец добавлен: <b>${esc(petLine(r))}</b>`);
      const v = await petsListView(env, uid);
      return send(env, 'client', chatId, v.text, v.kb);
    }
    if (s.state === 'ask_name') {
      if (text.length < 2 || text.length > 60 || text.startsWith('/')) {
        return send(env, 'client', chatId, 'Пожалуйста, напишите имя (от 2 до 60 символов).');
      }
      await setSession(env, 'client', uid, 'ask_phone', { name: text });
      return askPhone(env, chatId, text);
    }
    if (s.state === 'ask_phone') {
      const phone = normPhone(m.contact?.phone_number || text);
      if (!phone) return send(env, 'client', chatId, 'Не получилось распознать номер. Напишите его в формате +7 900 123-45-67.');
      await send(env, 'client', chatId, '✅ Спасибо!', CLIENT_MENU);
      return choosePetStep(env, uid, chatId, null, { ...s.data, phone });
    }
    if (s.state === 'ask_problem') {
      if (!text || text.startsWith('/')) return send(env, 'client', chatId, 'Напишите проблему текстом или нажмите «Пропустить».');
      await setSession(env, 'client', uid, 'choose_doctor', { ...s.data, problem: text.slice(0, MAX_PROBLEM) });
      const v = await doctorListView(env);
      return send(env, 'client', chatId, v.text, v.kb);
    }
    return send(env, 'client', chatId, 'Чтобы записаться к врачу, нажмите «📅 Записаться на приём».', CLIENT_MENU);
  }

  if (u.callback_query) {
    const q = u.callback_query, uid = q.from.id, msg = q.message, d = q.data || '';
    const [cmd, ...a] = d.split(':');
    let alert = null;

    if (cmd === 'me') {
      if (a[0] === 'edit') {
        await setSession(env, 'client', uid, 'ask_name', {});
        await edit(env, 'client', msg, '✏️ Обновим данные.');
        await send(env, 'client', msg.chat.id, '👤 Как вас зовут? Напишите имя.', { remove_keyboard: true });
      } else {
        const s = await getSession(env, 'client', uid);
        await choosePetStep(env, uid, msg.chat.id, msg, { name: s.data.name, phone: s.data.phone });
      }
    } else if (cmd === 'bp') {
      // выбран питомец из профиля для записи
      const s = await getSession(env, 'client', uid);
      const p = await getPet(env, uid, Number(a[0]));
      if (!p || !s.data.name) alert = 'Начните запись заново: «📅 Записаться на приём»';
      else {
        await setSession(env, 'client', uid, 'ask_problem', { name: s.data.name, phone: s.data.phone, ...petSnapshot(p) });
        await edit(env, 'client', msg, `🐾 Запись для: <b>${esc(petLine(p))}</b>`);
        await askProblem(env, 'client', msg.chat.id);
      }
    } else if (cmd === 'addpet') {
      const s = await getSession(env, 'client', uid);
      if ((await getPets(env, uid)).length >= MAX_PETS) alert = `Можно добавить не больше ${MAX_PETS} питомцев`;
      else {
        const forBooking = a[0] === 'b' && s.data.name;
        await setSession(env, 'client', uid, 'pet_kind', forBooking ? { ...s.data, after: 'booking' } : { after: 'profile' });
        await edit(env, 'client', msg, '➕ <b>Новый питомец</b>\n\nКто ваш питомец?', petKb('pk'));
      }
    } else if (cmd === 'pk') {
      const s = await getSession(env, 'client', uid);
      if (s.state !== 'pet_kind') alert = 'Начните заново';
      else {
        await setSession(env, 'client', uid, 'pet_name', { ...s.data, newPet: { kind: a[0] } });
        await edit(env, 'client', msg, `➕ <b>Новый питомец</b>: ${esc(petLabel(a[0]))}`);
        await send(env, 'client', msg.chat.id, 'Как зовут питомца? Напишите кличку.');
      }
    } else if (cmd === 'ps') {
      const s = await getSession(env, 'client', uid);
      if (s.state !== 'pet_sex') alert = 'Начните заново';
      else {
        await setSession(env, 'client', uid, 'pet_age', { ...s.data, newPet: { ...s.data.newPet, sex: a[0] } });
        await edit(env, 'client', msg, `<b>${esc(s.data.newPet.name)}</b> — ${SEX[a[0]]}`);
        await send(env, 'client', msg.chat.id, 'Сколько лет питомцу? Например: «3 года» или «5 месяцев».');
      }
    } else if (cmd === 'plist') {
      const v = await petsListView(env, uid);
      await edit(env, 'client', msg, v.text, v.kb);
    } else if (cmd === 'pv') {
      const p = await getPet(env, uid, Number(a[0]));
      if (!p) { const v = await petsListView(env, uid); await edit(env, 'client', msg, v.text, v.kb); }
      else await edit(env, 'client', msg,
        `🐾 <b>${esc(p.name)}</b>\n\nВид: ${esc(petLabel(p.kind))}\nПол: ${SEX[p.sex] || '—'}\nВозраст: ${esc(p.age)}`,
        ik([[{ text: '🗑 Удалить', callback_data: `pdel:${p.id}` }], [{ text: '◀️ К списку питомцев', callback_data: 'plist' }]]));
    } else if (cmd === 'pdel') {
      await tg(env, 'client', 'editMessageReplyMarkup', {
        chat_id: msg.chat.id, message_id: msg.message_id,
        reply_markup: ik([[{ text: '❗ Да, удалить', callback_data: `pdely:${a[0]}` }, { text: 'Нет', callback_data: `pv:${a[0]}` }]]),
      });
    } else if (cmd === 'pdely') {
      await env.DB.prepare('UPDATE pets SET active=0 WHERE id=? AND owner_id=?').bind(Number(a[0]), uid).run();
      const v = await petsListView(env, uid);
      await edit(env, 'client', msg, v.text, v.kb);
    } else if (cmd === 'prob') {
      const s = await getSession(env, 'client', uid);
      await setSession(env, 'client', uid, 'choose_doctor', { ...s.data, problem: '' });
      const v = await doctorListView(env);
      await edit(env, 'client', msg, v.text, v.kb);
    } else if (cmd === 'docs') {
      const v = await doctorListView(env);
      await edit(env, 'client', msg, v.text, v.kb);
    } else if (cmd === 'doc') {
      const v = await dateView(env, Number(a[0]));
      await edit(env, 'client', msg, v.text, v.kb);
    } else if (cmd === 'date') {
      const v = await timeView(env, Number(a[0]), a[1]);
      await edit(env, 'client', msg, v.text, v.kb);
    } else if (cmd === 'time') {
      const [docId, date, t] = [Number(a[0]), a[1], unhhmm(a[2])];
      const s = await getSession(env, 'client', uid);
      const doc = await getDoctor(env, docId);
      await edit(env, 'client', msg,
        `<b>Проверьте запись:</b>\n\n` + detailsText({ ...s.data, client_name: s.data.name, date, time: t }, doc),
        ik([[{ text: '✅ Подтвердить запись', callback_data: `ok:${docId}:${date}:${a[2]}` }],
            [{ text: '◀️ Выбрать другое время', callback_data: `date:${docId}:${date}` }]]));
    } else if (cmd === 'ok') {
      alert = await confirmBooking(env, q, Number(a[0]), a[1], unhhmm(a[2]));
    } else if (cmd === 'cancel') {
      await tg(env, 'client', 'editMessageReplyMarkup', {
        chat_id: msg.chat.id, message_id: msg.message_id,
        reply_markup: ik([[{ text: '❗ Да, отменить', callback_data: `cancelyes:${a[0]}` }, { text: 'Нет', callback_data: `cancelno:${a[0]}` }]]),
      });
    } else if (cmd === 'cancelno') {
      await tg(env, 'client', 'editMessageReplyMarkup', {
        chat_id: msg.chat.id, message_id: msg.message_id,
        reply_markup: ik([[{ text: '❌ Отменить запись', callback_data: `cancel:${a[0]}` }]]),
      });
    } else if (cmd === 'cancelyes') {
      const b = await env.DB.prepare("SELECT * FROM bookings WHERE id=? AND client_tg_id=? AND status='active'").bind(Number(a[0]), uid).first();
      if (!b) {
        await edit(env, 'client', msg, 'Эта запись уже отменена.');
      } else {
        await env.DB.prepare("UPDATE bookings SET status='cancelled', cancelled_by='client' WHERE id=?").bind(b.id).run();
        await edit(env, 'client', msg, `❌ Запись отменена.\n\n📅 ${fmtDate(b.date)}, 🕐 ${b.time}`);
        await notifyAdmins(env, await bookingCard(env, b, '❌ <b>Клиент отменил запись</b>') + '\n\nВремя снова свободно.');
      }
    }
    await tg(env, 'client', 'answerCallbackQuery', { callback_query_id: q.id, ...(alert ? { text: alert, show_alert: true } : {}) });
  }
}

// Создаёт запись, если слот свободен. Возвращает id или null, если время занято.
async function insertBooking(env, b) {
  const map = await slotMap(env, b.doctor_id, b.date);
  if (map[b.time]?.state !== 'free') return null;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO bookings (doctor_id, date, time, client_tg_id, client_name, phone, pet, pet_id, pet_name, pet_sex, pet_age, problem, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(b.doctor_id, b.date, b.time, b.client_tg_id ?? null, b.client_name, b.phone, b.pet ?? null,
      b.pet_id ?? null, b.pet_name ?? null, b.pet_sex ?? null, b.pet_age ?? null, b.problem ?? null, b.source).first();
    return r.id;
  } catch (e) {
    return null; // кто-то занял этот слот в ту же секунду
  }
}

async function confirmBooking(env, q, docId, date, time) {
  const uid = q.from.id, msg = q.message;
  const s = await getSession(env, 'client', uid);
  let { name, phone, pet = null, pet_id = null, pet_name = null, pet_sex = null, pet_age = null, problem = null } = s.data;
  if (!name || !phone) {
    const c = await env.DB.prepare('SELECT name, phone FROM clients WHERE tg_id=?').bind(uid).first();
    if (!c) { await edit(env, 'client', msg, 'Сессия устарела. Нажмите «📅 Записаться на приём» ещё раз.'); return null; }
    ({ name, phone } = c);
  }
  const b = { doctor_id: docId, date, time, client_tg_id: uid, client_name: name, phone, pet, pet_id, pet_name, pet_sex, pet_age, problem: problem || null, source: 'bot' };
  const id = await insertBooking(env, b);
  if (!id) {
    const v = await timeView(env, docId, date);
    await edit(env, 'client', msg, v.text, v.kb);
    return 'Это время уже занято, выберите другое 🙏';
  }
  b.id = id;
  await env.DB.prepare(
    'INSERT INTO clients (tg_id, name, phone) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET name=excluded.name, phone=excluded.phone'
  ).bind(uid, name, phone).run();
  await setSession(env, 'client', uid, '', {});

  await edit(env, 'client', msg,
    (await bookingCard(env, b, '🎉 <b>Вы записаны!</b>')) +
    '\n\nМы напомним о приёме накануне. Отменить запись можно в разделе «📋 Мои записи».' + clinicFooter(env));
  await notifyAdmins(env, await bookingCard(env, b, `🆕 <b>Новая запись #${id}</b>`),
    ik([[{ text: '❌ Отменить запись', callback_data: `bc:${id}` }]]));
  return null;
}

// ───────────────────────── Бот для администратора ─────────────────────────

const ADMIN_MENU = {
  keyboard: [
    [{ text: '📅 Сегодня' }, { text: '📆 Завтра' }],
    [{ text: '📝 Записать клиента' }, { text: '🔒 Закрыть / открыть время' }],
    [{ text: '📊 Неделя' }],
  ],
  resize_keyboard: true,
};

async function daySummary(env, date) {
  const docs = await getDoctors(env);
  let text = `📋 <b>Записи на ${fmtDate(date)}</b>\n`;
  let total = 0;
  for (const d of docs) {
    const map = await slotMap(env, d.id, date);
    const lines = [];
    for (const [t, s] of Object.entries(map)) {
      if (s.state === 'booked') {
        total++;
        const bk = s.booking;
        let line = `  ${t} — ${esc(bk.client_name)}, ${fmtPhone(bk.phone)}`;
        if (bk.pet) line += `\n        🐾 ${esc(petLine(bk))}`;
        if (bk.problem) line += `\n        <i>${esc(bk.problem.slice(0, 80))}${bk.problem.length > 80 ? '…' : ''}</i>`;
        lines.push(line);
      }
      else if (s.state === 'blocked') lines.push(`  ${t} — 🔒 закрыто`);
    }
    text += `\n🩺 <b>${esc(d.name)}</b> (${esc(d.specialty)})\n` + (lines.length ? lines.join('\n') : '  записей нет') + '\n';
  }
  text += `\nВсего записей: <b>${total}</b>`;
  return text;
}

async function weekSummary(env) {
  const dates = upcomingDates(env).slice(0, 7);
  const rows = (await env.DB.prepare(
    "SELECT date, COUNT(*) AS n FROM bookings WHERE status='active' AND date BETWEEN ? AND ? GROUP BY date"
  ).bind(dates[0], dates[dates.length - 1]).all()).results;
  const cnt = Object.fromEntries(rows.map((r) => [r.date, r.n]));
  return '📊 <b>Записи на неделю</b>\n\n' + dates.map((d) => `${shortDate(d)} — ${cnt[d] || 0}`).join('\n');
}

async function adminDoctorsView(env, forBooking = false) {
  const docs = await getDoctors(env);
  return {
    text: forBooking
      ? '📝 <b>Записать клиента</b>\n\nВыберите врача, затем дату и свободное время (✅).'
      : '🔒 <b>Закрыть / открыть время</b>\n\nВыберите врача:',
    kb: ik(docs.map((d) => [{ text: `${d.name} · ${d.specialty}`, callback_data: `sd:${d.id}` }])),
  };
}

async function adminDatesView(env, docId) {
  const doc = await getDoctor(env, docId);
  const rows = chunk(upcomingDates(env).map((d) => ({ text: shortDate(d), callback_data: `sdt:${docId}:${d}` })), 3);
  rows.push([{ text: '◀️ К врачам', callback_data: 'sdocs' }]);
  return { text: `🩺 <b>${esc(doc?.name)}</b>\n\nВыберите дату:`, kb: ik(rows) };
}

async function adminGridView(env, docId, date) {
  const doc = await getDoctor(env, docId);
  const map = await slotMap(env, docId, date);
  const icon = { free: '✅', blocked: '🔒', booked: '👤', past: '▫️' };
  const btns = Object.entries(map).map(([t, s]) => ({ text: `${icon[s.state]} ${t}`, callback_data: `sl:${docId}:${date}:${hhmm(t)}` }));
  const rows = chunk(btns, 4);
  rows.push([{ text: '🔒 Закрыть весь день', callback_data: `sall:${docId}:${date}:c` }, { text: '🔓 Открыть весь день', callback_data: `sall:${docId}:${date}:o` }]);
  rows.push([{ text: '◀️ К датам', callback_data: `sd:${docId}` }]);
  const text = `🩺 <b>${esc(doc?.name)}</b>\n📅 ${fmtDate(date)}\n\n` +
    '✅ свободно — нажмите, чтобы записать клиента или закрыть\n🔒 закрыто — нажмите, чтобы открыть\n👤 есть запись — нажмите, чтобы посмотреть или отменить\n▫️ время прошло';
  return { text, kb: ik(rows) };
}

async function adminConfirm(env, chatId, uid) {
  const s = await getSession(env, 'admin', uid);
  const d = s.data;
  const doc = await getDoctor(env, d.docId);
  return send(env, 'admin', chatId,
    '<b>Проверьте запись:</b>\n\n' + detailsText({ ...d, client_name: d.name }, doc),
    ik([[{ text: '✅ Записать', callback_data: 'aok' }, { text: '✖️ Отмена', callback_data: 'ano' }]]));
}

async function handleAdmin(env, u) {
  const from = u.message?.from || u.callback_query?.from;
  if (!from) return;
  if (!isAdmin(env, from.id)) {
    if (u.message) await send(env, 'admin', u.message.chat.id, `⛔ Нет доступа.\n\nВаш Telegram ID: <code>${from.id}</code>\nПередайте его разработчику, чтобы получить доступ.`);
    if (u.callback_query) await tg(env, 'admin', 'answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'Нет доступа' });
    return;
  }

  if (u.message) {
    const chatId = u.message.chat.id, text = (u.message.text || '').trim();
    const isMenu = text.startsWith('/') || ADMIN_MENU.keyboard.flat().some((b) => b.text === text);
    if (isMenu) await setSession(env, 'admin', from.id, '', {});
    else {
      // Админ заполняет анкету клиента, которого записывает вручную
      const s = await getSession(env, 'admin', from.id);
      if (s.state === 'a_name') {
        if (text.length < 2 || text.length > 60) return send(env, 'admin', chatId, 'Напишите имя клиента (от 2 до 60 символов).');
        await setSession(env, 'admin', from.id, 'a_phone', { ...s.data, name: text });
        return send(env, 'admin', chatId, '📞 Телефон клиента?');
      }
      if (s.state === 'a_phone') {
        const phone = normPhone(text);
        if (!phone) return send(env, 'admin', chatId, 'Не получилось распознать номер. Пример: +7 900 123-45-67');
        await setSession(env, 'admin', from.id, 'a_pet', { ...s.data, phone });
        return askPet(env, 'admin', chatId);
      }
      if (s.state === 'a_pname') {
        if (text.length < 1 || text.length > 30) return send(env, 'admin', chatId, 'Напишите кличку (до 30 символов).');
        await setSession(env, 'admin', from.id, 'a_psex', { ...s.data, pet_name: text });
        return send(env, 'admin', chatId, `<b>${esc(text)}</b> — мальчик или девочка?`,
          ik([[{ text: '♂️ Мальчик', callback_data: 'apsx:m' }, { text: '♀️ Девочка', callback_data: 'apsx:f' }]]));
      }
      if (s.state === 'a_page') {
        if (text.length > 20) return send(env, 'admin', chatId, 'Коротко, например: «3 года».');
        await setSession(env, 'admin', from.id, 'a_problem', { ...s.data, pet_age: text });
        return askProblem(env, 'admin', chatId);
      }
      if (s.state === 'a_problem') {
        await setSession(env, 'admin', from.id, 'a_confirm', { ...s.data, problem: text.slice(0, MAX_PROBLEM) });
        return adminConfirm(env, chatId, from.id);
      }
    }
    if (text === '/start') return send(env, 'admin', chatId, `👋 Панель администратора <b>${esc(env.CLINIC_NAME || '')}</b>\n\nСюда приходят новые записи и отмены. Каждое утро — сводка на день.`, ADMIN_MENU);
    if (text === '📅 Сегодня' || text === '/today') return send(env, 'admin', chatId, await daySummary(env, today(env)), ADMIN_MENU);
    if (text === '📆 Завтра' || text === '/tomorrow') return send(env, 'admin', chatId, await daySummary(env, addDays(today(env), 1)), ADMIN_MENU);
    if (text === '📊 Неделя' || text === '/week') return send(env, 'admin', chatId, await weekSummary(env), ADMIN_MENU);
    if (text === '🔒 Закрыть / открыть время' || text === '/slots') { const v = await adminDoctorsView(env); return send(env, 'admin', chatId, v.text, v.kb); }
    if (text === '📝 Записать клиента' || text === '/new') { const v = await adminDoctorsView(env, true); return send(env, 'admin', chatId, v.text, v.kb); }
    return send(env, 'admin', chatId, 'Выберите действие в меню 👇', ADMIN_MENU);
  }

  const q = u.callback_query, msg = q.message;
  const [cmd, ...a] = (q.data || '').split(':');
  let alert = null;

  if (cmd === 'sdocs') { const v = await adminDoctorsView(env); await edit(env, 'admin', msg, v.text, v.kb); }
  else if (cmd === 'sd') { const v = await adminDatesView(env, Number(a[0])); await edit(env, 'admin', msg, v.text, v.kb); }
  else if (cmd === 'sdt') { const v = await adminGridView(env, Number(a[0]), a[1]); await edit(env, 'admin', msg, v.text, v.kb); }
  else if (cmd === 'sl') {
    const [docId, date, t] = [Number(a[0]), a[1], unhhmm(a[2])];
    const s = (await slotMap(env, docId, date))[t];
    const back = [{ text: '◀️ Назад к сетке', callback_data: `sdt:${docId}:${date}` }];
    if (s?.state === 'free') {
      const doc = await getDoctor(env, docId);
      await edit(env, 'admin', msg, `🩺 <b>${esc(doc?.name)}</b>\n📅 ${fmtDate(date)}, 🕐 ${t}\n\nЧто сделать с этим временем?`,
        ik([[{ text: '📝 Записать клиента', callback_data: `abk:${docId}:${date}:${a[2]}` }],
            [{ text: '🔒 Закрыть время', callback_data: `blk:${docId}:${date}:${a[2]}` }], back]));
    } else if (s?.state === 'blocked') {
      await env.DB.prepare('DELETE FROM blocks WHERE doctor_id=? AND date=? AND time=?').bind(docId, date, t).run();
      const v = await adminGridView(env, docId, date); await edit(env, 'admin', msg, v.text, v.kb);
    } else if (s?.state === 'booked') {
      await edit(env, 'admin', msg, await bookingCard(env, s.booking, `👤 <b>Запись #${s.booking.id}</b>`),
        ik([[{ text: '❌ Отменить запись', callback_data: `bc:${s.booking.id}` }], back]));
    } else alert = 'Это время уже прошло';
  } else if (cmd === 'blk') {
    const [docId, date, t] = [Number(a[0]), a[1], unhhmm(a[2])];
    if ((await slotMap(env, docId, date))[t]?.state === 'free') {
      await env.DB.prepare('INSERT OR IGNORE INTO blocks (doctor_id, date, time, created_by) VALUES (?, ?, ?, ?)').bind(docId, date, t, from.id).run();
    } else alert = 'Это время уже занято';
    const v = await adminGridView(env, docId, date); await edit(env, 'admin', msg, v.text, v.kb);
  } else if (cmd === 'abk') {
    const [docId, date, t] = [Number(a[0]), a[1], unhhmm(a[2])];
    await setSession(env, 'admin', from.id, 'a_name', { docId, date, time: t });
    await edit(env, 'admin', msg, `📝 Запись клиента на ${fmtDate(date)}, ${t}`);
    await send(env, 'admin', msg.chat.id, '👤 Имя клиента?');
  } else if (cmd === 'apet') {
    const s = await getSession(env, 'admin', from.id);
    if (s.state !== 'a_pet') alert = 'Начните запись заново';
    else {
      await setSession(env, 'admin', from.id, 'a_pname', { ...s.data, pet: a[0] });
      await edit(env, 'admin', msg, `🐾 Питомец: <b>${esc(petLabel(a[0]))}</b>`);
      await send(env, 'admin', msg.chat.id, 'Кличка питомца?');
    }
  } else if (cmd === 'apsx') {
    const s = await getSession(env, 'admin', from.id);
    if (s.state !== 'a_psex') alert = 'Начните запись заново';
    else {
      await setSession(env, 'admin', from.id, 'a_page', { ...s.data, pet_sex: a[0] });
      await edit(env, 'admin', msg, `<b>${esc(s.data.pet_name)}</b> — ${SEX[a[0]]}`);
      await send(env, 'admin', msg.chat.id, 'Возраст питомца? Например: «3 года» или «5 месяцев».',
        ik([[{ text: 'Не знаю, пропустить ➡️', callback_data: 'apage:skip' }]]));
    }
  } else if (cmd === 'apage') {
    const s = await getSession(env, 'admin', from.id);
    if (s.state !== 'a_page') alert = 'Начните запись заново';
    else {
      await setSession(env, 'admin', from.id, 'a_problem', s.data);
      await edit(env, 'admin', msg, 'Возраст: —');
      await askProblem(env, 'admin', msg.chat.id);
    }
  } else if (cmd === 'aprob') {
    const s = await getSession(env, 'admin', from.id);
    if (s.state !== 'a_problem') alert = 'Начните запись заново';
    else {
      await setSession(env, 'admin', from.id, 'a_confirm', { ...s.data, problem: '' });
      await edit(env, 'admin', msg, '📝 Проблема: —');
      await adminConfirm(env, msg.chat.id, from.id);
    }
  } else if (cmd === 'aok') {
    const s = await getSession(env, 'admin', from.id);
    if (s.state !== 'a_confirm') alert = 'Начните запись заново';
    else {
      const d = s.data;
      const b = { doctor_id: d.docId, date: d.date, time: d.time, client_tg_id: null, client_name: d.name, phone: d.phone,
        pet: d.pet, pet_name: d.pet_name, pet_sex: d.pet_sex, pet_age: d.pet_age, problem: d.problem || null, source: 'admin' };
      const id = await insertBooking(env, b);
      await setSession(env, 'admin', from.id, '', {});
      if (!id) {
        await edit(env, 'admin', msg, '😔 Это время уже заняли. Выберите другое через «📝 Записать клиента».');
      } else {
        b.id = id;
        await edit(env, 'admin', msg, await bookingCard(env, b, `✅ <b>Клиент записан, #${id}</b>`),
          ik([[{ text: '❌ Отменить запись', callback_data: `bc:${id}` }]]));
        for (const aid of adminIds(env)) {
          if (aid !== String(from.id)) await send(env, 'admin', aid, await bookingCard(env, b, `🆕 <b>Новая запись #${id}</b>`), ik([[{ text: '❌ Отменить запись', callback_data: `bc:${id}` }]]));
        }
      }
    }
  } else if (cmd === 'ano') {
    await setSession(env, 'admin', from.id, '', {});
    await edit(env, 'admin', msg, 'Запись не создана.');
  } else if (cmd === 'sall') {
    const [docId, date, mode] = [Number(a[0]), a[1], a[2]];
    if (mode === 'o') await env.DB.prepare('DELETE FROM blocks WHERE doctor_id=? AND date=?').bind(docId, date).run();
    else {
      const map = await slotMap(env, docId, date);
      const stmts = Object.entries(map).filter(([, s]) => s.state === 'free')
        .map(([t]) => env.DB.prepare('INSERT OR IGNORE INTO blocks (doctor_id, date, time, created_by) VALUES (?, ?, ?, ?)').bind(docId, date, t, from.id));
      if (stmts.length) await env.DB.batch(stmts);
    }
    const v = await adminGridView(env, docId, date); await edit(env, 'admin', msg, v.text, v.kb);
  } else if (cmd === 'bc') {
    await tg(env, 'admin', 'editMessageReplyMarkup', {
      chat_id: msg.chat.id, message_id: msg.message_id,
      reply_markup: ik([[{ text: '❗ Да, отменить и уведомить клиента', callback_data: `bcy:${a[0]}` }], [{ text: 'Нет', callback_data: `bcn:${a[0]}` }]]),
    });
  } else if (cmd === 'bcn') {
    await tg(env, 'admin', 'editMessageReplyMarkup', {
      chat_id: msg.chat.id, message_id: msg.message_id,
      reply_markup: ik([[{ text: '❌ Отменить запись', callback_data: `bc:${a[0]}` }]]),
    });
  } else if (cmd === 'bcy') {
    const b = await env.DB.prepare("SELECT * FROM bookings WHERE id=? AND status='active'").bind(Number(a[0])).first();
    if (!b) {
      alert = 'Запись уже отменена';
      await tg(env, 'admin', 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: ik([]) });
    } else {
      await env.DB.prepare("UPDATE bookings SET status='cancelled', cancelled_by='admin' WHERE id=?").bind(b.id).run();
      await edit(env, 'admin', msg, await bookingCard(env, b, `❌ <b>Запись #${b.id} отменена администратором</b>`));
      if (b.client_tg_id) {
        await send(env, 'client', b.client_tg_id,
          (await bookingCard(env, { ...b, source: 'bot' }, '❌ <b>Ваша запись отменена клиникой</b>')) +
          '\n\nЧтобы выбрать другое время, нажмите «📅 Записаться на приём».' + clinicFooter(env), CLIENT_MENU);
      }
    }
  }
  await tg(env, 'admin', 'answerCallbackQuery', { callback_query_id: q.id, ...(alert ? { text: alert, show_alert: true } : {}) });
}

// ───────────────────────── Расписание (cron) ─────────────────────────

async function morningSummary(env) {
  await notifyAdmins(env, '☀️ Доброе утро!\n\n' + (await daySummary(env, today(env))));
}

// Вечерние итоги дня: сколько было записей, отмен, кто записывал + сколько записей на завтра
async function eveningSummary(env) {
  const t = today(env), tm = addDays(t, 1);
  const r = await env.DB.prepare(
    `SELECT
       SUM(status='active') AS active,
       SUM(status='cancelled') AS cancelled,
       SUM(status='active' AND source='bot') AS via_bot,
       SUM(status='active' AND source='admin') AS via_admin
     FROM bookings WHERE date=?`
  ).bind(t).first();
  const created = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE date(created_at, '+' || ? || ' minutes')=?")
    .bind(Number(env.TZ_OFFSET_MIN ?? 180), t).first();
  const tmr = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE date=? AND status='active'").bind(tm).first();
  const docs = await getDoctors(env);
  const per = (await env.DB.prepare("SELECT doctor_id, COUNT(*) AS n FROM bookings WHERE date=? AND status='active' GROUP BY doctor_id").bind(t).all()).results;
  const perMap = Object.fromEntries(per.map((x) => [x.doctor_id, x.n]));
  const text =
    `🌙 <b>Итоги дня — ${fmtDate(t)}</b>\n\n` +
    `✅ Приёмов сегодня: <b>${r?.active || 0}</b> (через бота: ${r?.via_bot || 0}, вручную: ${r?.via_admin || 0})\n` +
    `❌ Отменено: <b>${r?.cancelled || 0}</b>\n` +
    `🆕 Новых записей за день (на любые даты): <b>${created?.n || 0}</b>\n\n` +
    `<b>По врачам:</b>\n` + docs.map((d) => `🩺 ${esc(d.name)} — ${perMap[d.id] || 0}`).join('\n') +
    `\n\n📆 На завтра (${fmtDate(tm)}) записано: <b>${tmr?.n || 0}</b>`;
  await notifyAdmins(env, text);
}

async function sendReminders(env) {
  const tomorrow = addDays(today(env), 1);
  const rows = (await env.DB.prepare(
    "SELECT * FROM bookings WHERE date=? AND status='active' AND reminded=0"
  ).bind(tomorrow).all()).results;
  for (const b of rows) {
    if (!b.client_tg_id) continue; // записан администратором, Telegram клиента неизвестен
    await send(env, 'client', b.client_tg_id,
      (await bookingCard(env, b, '⏰ <b>Напоминание: завтра у вас приём</b>')) + clinicFooter(env),
      ik([[{ text: '❌ Не смогу прийти — отменить', callback_data: `cancel:${b.id}` }]]));
    await env.DB.prepare('UPDATE bookings SET reminded=1 WHERE id=?').bind(b.id).run();
  }
}

// ───────────────────────── Точка входа ─────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const res = { mode: singleBot(env) ? 'один бот (админ-панель внутри клиентского)' : 'два бота' };
      for (const bot of singleBot(env) ? ['client'] : ['client', 'admin']) {
        res[bot] = await tg(env, bot, 'setWebhook', {
          url: `${url.origin}/tg/${bot}`, secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
        });
      }
      res.clientCommands = await tg(env, 'client', 'setMyCommands', { commands: [
        { command: 'start', description: 'Главное меню' },
        { command: 'book', description: 'Записаться на приём' },
        { command: 'pets', description: 'Мои питомцы' },
        { command: 'my', description: 'Мои записи' },
      ] });
      const adminCommands = [
        { command: 'start', description: 'Панель администратора' },
        { command: 'new', description: 'Записать клиента' },
        { command: 'today', description: 'Записи на сегодня' },
        { command: 'tomorrow', description: 'Записи на завтра' },
        { command: 'week', description: 'Сводка на неделю' },
        { command: 'slots', description: 'Закрыть / открыть время' },
      ];
      if (singleBot(env)) {
        // Админам в том же боте показываем своё меню команд
        res.adminCommands = [];
        for (const id of adminIds(env)) {
          if (id !== '0') res.adminCommands.push(await tg(env, 'client', 'setMyCommands', { commands: adminCommands, scope: { type: 'chat', chat_id: Number(id) } }));
        }
      } else {
        res.adminCommands = await tg(env, 'admin', 'setMyCommands', { commands: adminCommands });
      }
      return Response.json(res);
    }

    const m = url.pathname.match(/^\/tg\/(client|admin)$/);
    if (m && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      try {
        const update = await request.json();
        if (m[1] === 'client') await handleClient(env, update);
        else await handleAdmin(env, update);
      } catch (e) {
        console.log('handler error', e?.stack || String(e));
      }
      return new Response('ok');
    }

    return new Response('Vet bot is running');
  },

  async scheduled(event, env, ctx) {
    // Время cron — UTC. 05:00 UTC = 08:00 МСК, 15:00 UTC = 18:00 МСК, 17:00 UTC = 20:00 МСК
    if (event.cron === '0 5 * * *') ctx.waitUntil(morningSummary(env));
    if (event.cron === '0 15 * * *') ctx.waitUntil(sendReminders(env));
    if (event.cron === '0 17 * * *') ctx.waitUntil(eveningSummary(env));
  },
};

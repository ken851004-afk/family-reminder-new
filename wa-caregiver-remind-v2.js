/**
 * GitHub Actions: 照顧者個人 WhatsApp 提醒
 * - 提早 1 天提醒（每日 09:00 HKT 發送）
 * - 提早 3 小時提醒（每小時檢查）
 *
 * v2: 從 family-reminder-cloud 讀取數據（公開 repo，無需 PAT）
 *     本地快取追蹤已通知紀錄，不寫入 cloud repo
 */

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('baileys');
const fs = require('fs');
const https = require('https');
const path = require('path');

// ===== Config =====
const DATA_URL = 'https://raw.githubusercontent.com/ken851004-afk/family-reminder-cloud/master/data.json';
const NOTIFIED_CACHE_FILE = '/tmp/wa-caregiver-notified.json';

// Caregiver phone map
const CAREGIVER_PHONES = {
  'KEN':         { phone: '852622189999', name: 'KEN' },
  'EPPIE':       { phone: '85262218999',  name: 'EPPIE' },
  'Kenny Yam':   { phone: '85291339336',  name: 'Kenny Yam' },
  'Rosanna Mok': { phone: '85293398522',  name: 'Rosanna Mok' },
  'COFFE':       { phone: '85266713322',  name: 'COFFE' },
  '老豆':        { phone: '85262269100',  name: '老豆' }
};

const GROUP_ID = '120363412134951607@g.us';
const CAT_ICONS = { school: '🏫', class: '🎨', special: '⭐', summer: '☀️', routine: '📅' };
const DAY_NAMES = ['日','一','二','三','四','五','六'];

// ===== Data fetch (public URL, no auth) =====
function fetchData() {
  return new Promise((resolve, reject) => {
    const url = new URL(DATA_URL);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: { 'User-Agent': 'wa-caregiver-remind-v2' }
    };
    const req = https.request(opts, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = new URL(res.headers.location);
        opts.hostname = redirectUrl.hostname;
        opts.path = redirectUrl.pathname;
        const req2 = https.request(opts, handleResponse);
        req2.on('error', reject);
        req2.end();
        return;
      }
      handleResponse(res);
    });
    req.on('error', reject);
    req.end();

    function handleResponse(res) {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch(e) {
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
    }
  });
}

// ===== Notified cache (local file, cross-run) =====
function loadNotifiedCache() {
  try {
    if (fs.existsSync(NOTIFIED_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(NOTIFIED_CACHE_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function saveNotifiedCache(cache) {
  fs.writeFileSync(NOTIFIED_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

// ===== Helpers =====
function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+08:00');
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}`;
}

function getWeekDay(dateStr) {
  return DAY_NAMES[new Date(dateStr + 'T00:00:00+08:00').getUTCDay()];
}

function buildCaregiverMsg(r, type) {
  const icon = CAT_ICONS[r.category] || '📌';
  const prefix = type === '1day' ? '⏰ 提早一天提醒' : '🚨 三小時後提醒';
  let msg = `${prefix}\n\n`;
  msg += `${icon} *${r.name}*\n`;
  msg += `📅 ${formatDate(r.date)}（星期${getWeekDay(r.date)}）${r.time && r.time !== '00:00' ? ' ' + r.time : ''}\n`;
  if (r.address) msg += `📍 ${r.address}\n`;
  if (r.note) msg += `📝 ${r.note}\n`;

  if (r.caregiver === 'ALL') {
    msg += `\n👥 照顧者：全部人\n`;
  } else {
    msg += `\n👤 照顧者：${r.caregiver}\n`;
  }

  msg += `🌐 查看全部：https://ken851004-afk.github.io/family-reminder-cloud`;
  return msg;
}

// ===== Main =====
async function main() {
  console.log('=== Caregiver WhatsApp Reminder v2 ===');
  const now = new Date();
  const hkNow = new Date(now.getTime() + 8 * 3600000);
  const hkHour = hkNow.getUTCHours();
  const hkDateStr = `${hkNow.getUTCFullYear()}-${String(hkNow.getUTCMonth()+1).padStart(2,'0')}-${String(hkNow.getUTCDate()).padStart(2,'0')}`;

  console.log(`[TIME] HKT: ${hkDateStr} ${String(hkHour).padStart(2,'0')}:${String(hkNow.getUTCMinutes()).padStart(2,'0')}`);

  // 1. Fetch data
  console.log('[DATA] Fetching from family-reminder-cloud...');
  let data;
  try {
    data = await fetchData();
  } catch(e) {
    console.error('[DATA] Failed:', e.message);
    console.log('=== Done (data fetch failed) ===');
    process.exit(0); // exit gracefully, next run retries
  }
  const reminders = data.reminders || [];
  console.log(`[DATA] Loaded ${reminders.length} reminders`);

  // 2. Check which need notification
  const notifiedCache = loadNotifiedCache();
  const toNotify = [];
  
  // Clean old entries from cache (older than 30 days)
  const thirtyDaysAgo = now.getTime() - 30 * 86400000;
  for (const key of Object.keys(notifiedCache)) {
    if (notifiedCache[key].ts < thirtyDaysAgo) delete notifiedCache[key];
  }

  for (const r of reminders) {
    if (!r.caregiver) continue;
    if (r.caregiver !== 'ALL' && !CAREGIVER_PHONES[r.caregiver]) continue;

    const eventDate = r.date;
    const eventTime = r.time || '09:00';
    const today = new Date(hkDateStr + 'T00:00:00+08:00');
    const eventDay = new Date(eventDate + 'T00:00:00+08:00');
    const daysUntil = Math.ceil((eventDay - today) / 86400000);

    const cacheKey = `${r.id || r.name}_${r.date}`;

    // 1-day-before: only at 09:00 HKT
    if (daysUntil === 1 && hkHour === 9 && !notifiedCache[cacheKey + '_1d']) {
      toNotify.push({ reminder: r, type: '1day' });
      notifiedCache[cacheKey + '_1d'] = { ts: now.getTime() };
      console.log(`[1DAY] ${r.name} → ${r.caregiver || 'ALL'}`);
    }

    // 3-hours-before: event is today
    if (daysUntil === 0 && !notifiedCache[cacheKey + '_3h']) {
      const [eh, em] = eventTime.split(':').map(Number);
      const eventMins = eh * 60 + em;
      const nowMins = hkHour * 60 + hkNow.getUTCMinutes();
      const diffMin = eventMins - nowMins;

      if (diffMin >= 150 && diffMin <= 210) {
        toNotify.push({ reminder: r, type: '3hour' });
        notifiedCache[cacheKey + '_3h'] = { ts: now.getTime() };
        console.log(`[3HOUR] ${r.name} (${eventTime}) → ${r.caregiver || 'ALL'}`);
      }
    }
  }

  saveNotifiedCache(notifiedCache);

  if (toNotify.length === 0) {
    console.log('[CRON] No notifications needed. Exiting.');
    process.exit(0);
  }

  console.log(`[CRON] ${toNotify.length} notifications to send`);

  // 3. Decode WhatsApp creds
  if (!process.env.WA_CREDS_B64) {
    console.log('[WA] WA_CREDS_B64 not set - skipping WhatsApp send (set this secret to enable)');
    console.log('[WA] Notifications queued for send but WhatsApp not configured.');
    console.log('=== Done (WhatsApp not configured) ===');
    process.exit(0); // exit gracefully, no failure
  }
  const credsJson = Buffer.from(process.env.WA_CREDS_B64, 'base64').toString('utf8');
  const SESSION_DIR = '/tmp/wa-session-caregiver';
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_DIR, 'creds.json'), credsJson);
  console.log('[WA] creds.json written');

  // 4. Connect & send
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      logger: require('pino')({ level: 'silent' }),
      browser: ['Caregiver Reminder v2', 'Chrome', '2.0.0']
    });

    let sent = 0;
    let failed = 0;
    const target = toNotify.length;

    const timeout = setTimeout(() => {
      console.error(`[WA] Timeout: sent ${sent}/${target}, failed ${failed}`);
      sock.end();
      resolve();
    }, 120000);

    sock.ev.on('creds.update', () => saveCreds());

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('[WA] Connected!');
        for (const item of toNotify) {
          const r = item.reminder;
          const msg = buildCaregiverMsg(r, item.type);

          if (r.caregiver === 'ALL') {
            for (const [careName, careInfo] of Object.entries(CAREGIVER_PHONES)) {
              const jid = careInfo.phone + '@s.whatsapp.net';
              try {
                await sock.sendMessage(jid, { text: msg });
                sent++;
                console.log(`[OK] ${r.name} → ${careInfo.name} [${item.type}]`);
                await new Promise(r => setTimeout(r, 1500));
              } catch(e) {
                failed++;
                console.error(`[FAIL] ${r.name} → ${careInfo.name}: ${e.message}`);
              }
            }
          } else {
            const care = CAREGIVER_PHONES[r.caregiver];
            if (!care) { console.log(`[SKIP] No phone for ${r.caregiver}`); continue; }
            const jid = care.phone + '@s.whatsapp.net';
            try {
              await sock.sendMessage(jid, { text: msg });
              sent++;
              console.log(`[OK] ${r.name} → ${care.name} [${item.type}]`);
              await new Promise(r => setTimeout(r, 1000));
            } catch(e) {
              failed++;
              console.error(`[FAIL] ${r.name} → ${care.name}: ${e.message}`);
            }
          }
        }
        console.log(`[WA] Done: ${sent} sent, ${failed} failed`);
        clearTimeout(timeout);
        setTimeout(() => { sock.end(); resolve(); }, 2000);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[WA] Closed (code: ${code}), sent=${sent}`);
        clearTimeout(timeout);
        resolve(); // Don't reject - WhatsApp disconnect is OK if messages were sent
      }
    });
  });
}

main().then(() => {
  console.log('=== Done ===');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

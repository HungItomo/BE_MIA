import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;
const port = Number(process.env.PORT) || 4000;
const databaseUrl = process.env.DATABASE_URL || '';
const databaseHost = process.env.DB_HOST || 'localhost';
const databasePort = Number(process.env.DB_PORT) || 5432;
const databaseName = process.env.DB_DATABASE || 'mia';
const databaseUser = process.env.DB_USERNAME || 'postgres';
const databaseSsl = String(process.env.DB_SSL || process.env.PGSSLMODE || '').toLowerCase() === 'true'
  || String(process.env.PGSSLMODE || '').toLowerCase() === 'require';

const pool = new Pool({
  ...(databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: databaseHost,
        port: databasePort,
        user: databaseUser,
        password: process.env.DB_PASSWORD || '',
        database: databaseName,
      }),
  ...(databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 10,
  connectionTimeoutMillis: 10000,
});

let databaseReady = false;
let databaseError = null;
let server;
let databaseRetryTimer;

const app = express();
const normalizeOrigin = (value) => String(value || '').trim().replace(/\/+$/, '');
const allowedOrigins = new Set([
  process.env.FE_DOMAIN_DEV,
  process.env.FE_DOMAIN_PROD,
  process.env.CORS_ORIGIN_A,
  process.env.CORS_ORIGIN_B,
  process.env.CORS_ORIGIN_C,
  ...(process.env.CORS_ORIGINS || '').split(','),
].map(normalizeOrigin).filter(Boolean));

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(normalizeOrigin(origin))) {
      return callback(null, true);
    }
    return callback(new Error('Origin không được phép truy cập API.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const validTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'mia-milk-tracker-api' });
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS milk_entries (
      id UUID PRIMARY KEY,
      date DATE NOT NULL,
      time TIME NOT NULL,
      amount_ml INTEGER NOT NULL CHECK (amount_ml > 0 AND amount_ml <= 3000),
      note VARCHAR(160) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_milk_entries_date ON milk_entries (date)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pump_entries (
      id UUID PRIMARY KEY,
      date DATE NOT NULL,
      time TIME NOT NULL,
      side VARCHAR(10) NOT NULL DEFAULT 'both' CHECK (side IN ('left', 'right', 'both')),
      amount_ml INTEGER NOT NULL CHECK (amount_ml > 0 AND amount_ml <= 3000),
      note VARCHAR(160) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pump_entries_date ON pump_entries (date)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sleep_entries (
      id UUID PRIMARY KEY,
      date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
      note VARCHAR(160) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_sleep_entries_date ON sleep_entries (date)');
}

function validateEntry(payload) {
  const { date, time, amountMl, note = '' } = payload || {};
  const parsedAmount = Number(amountMl);

  if (!validDate(date)) return 'Ngày uống không hợp lệ.';
  if (!validTime(time)) return 'Giờ uống không hợp lệ.';
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 3000) {
    return 'Lượng sữa phải lớn hơn 0 và không quá 3.000 ml.';
  }
  if (String(note).length > 160) return 'Ghi chú không được vượt quá 160 ký tự.';
  return null;
}

function normalizePayload(payload) {
  return {
    date: payload.date,
    time: payload.time,
    amountMl: Math.round(Number(payload.amountMl)),
    note: String(payload.note || '').trim(),
  };
}

function mapEntry(row) {
  return {
    id: row.id,
    date: row.date,
    time: String(row.time).slice(0, 5),
    amountMl: Number(row.amountMl),
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const validPumpSides = ['left', 'right', 'both'];

function validatePumpEntry(payload) {
  const { date, time, side = 'both', amountMl, note = '' } = payload || {};
  const parsedAmount = Number(amountMl);
  if (!validDate(date)) return 'Ngày hút sữa không hợp lệ.';
  if (!validTime(time)) return 'Giờ hút sữa không hợp lệ.';
  if (!validPumpSides.includes(side)) return 'Bên hút sữa không hợp lệ.';
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 3000) {
    return 'Lượng sữa hút phải lớn hơn 0 và không quá 3.000 ml.';
  }
  if (String(note).length > 160) return 'Ghi chú không được vượt quá 160 ký tự.';
  return null;
}

function normalizePumpEntry(payload) {
  return {
    date: payload.date,
    time: payload.time,
    side: validPumpSides.includes(payload.side) ? payload.side : 'both',
    amountMl: Math.round(Number(payload.amountMl)),
    note: String(payload.note || '').trim(),
  };
}

function mapPumpEntry(row) {
  return {
    id: row.id,
    date: row.date,
    time: String(row.time).slice(0, 5),
    side: row.side,
    amountMl: Number(row.amountMl),
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function calculateDurationMinutes(startTime, endTime) {
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  let duration = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
  if (duration <= 0) duration += 24 * 60;
  return duration;
}

function validateSleepEntry(payload) {
  const { date, startTime, endTime, note = '' } = payload || {};
  if (!validDate(date)) return 'Ngày ngủ không hợp lệ.';
  if (!validTime(startTime) || !validTime(endTime)) return 'Giờ bắt đầu hoặc kết thúc không hợp lệ.';
  if (startTime === endTime) return 'Giờ bắt đầu và kết thúc không được giống nhau.';
  if (calculateDurationMinutes(startTime, endTime) > 1440) return 'Thời lượng ngủ không hợp lệ.';
  if (String(note).length > 160) return 'Ghi chú không được vượt quá 160 ký tự.';
  return null;
}

function normalizeSleepEntry(payload) {
  return {
    date: payload.date,
    startTime: payload.startTime,
    endTime: payload.endTime,
    durationMinutes: calculateDurationMinutes(payload.startTime, payload.endTime),
    note: String(payload.note || '').trim(),
  };
}

function mapSleepEntry(row) {
  return {
    id: row.id,
    date: row.date,
    startTime: String(row.startTime).slice(0, 5),
    endTime: String(row.endTime).slice(0, 5),
    durationMinutes: Number(row.durationMinutes),
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const entryReturning = `
  RETURNING
    id,
    TO_CHAR(date, 'YYYY-MM-DD') AS date,
    TO_CHAR(time, 'HH24:MI') AS time,
    amount_ml AS "amountMl",
    note,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
`;

const pumpReturning = `
  RETURNING
    id,
    TO_CHAR(date, 'YYYY-MM-DD') AS date,
    TO_CHAR(time, 'HH24:MI') AS time,
    side,
    amount_ml AS "amountMl",
    note,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
`;

const sleepReturning = `
  RETURNING
    id,
    TO_CHAR(date, 'YYYY-MM-DD') AS date,
    TO_CHAR(start_time, 'HH24:MI') AS "startTime",
    TO_CHAR(end_time, 'HH24:MI') AS "endTime",
    duration_minutes AS "durationMinutes",
    note,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
`;

app.get('/api/health', async (_req, res, next) => {
  if (!databaseReady) {
    return res.status(503).json({
      status: 'starting',
      service: 'mia-milk-tracker-api',
      database: 'disconnected',
      message: process.env.NODE_ENV === 'development'
        ? databaseError?.message || 'Đang kết nối PostgreSQL.'
        : databaseError?.code
          ? `PostgreSQL chưa sẵn sàng (${databaseError.code}).`
          : 'Đang kết nối PostgreSQL.',
    });
  }

  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'mia-milk-tracker-api', database: 'connected' });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || databaseReady) return next();
  return res.status(503).json({
    message: 'PostgreSQL chưa sẵn sàng. Kiểm tra DATABASE_URL hoặc nhóm biến DB_* trên Render.',
  });
});

app.get('/api/entries', async (req, res, next) => {
  try {
    const { date, from, to } = req.query;
    if (date && !validDate(date)) return res.status(400).json({ message: 'Tham số date không hợp lệ.' });
    if (from && !validDate(from)) return res.status(400).json({ message: 'Tham số from không hợp lệ.' });
    if (to && !validDate(to)) return res.status(400).json({ message: 'Tham số to không hợp lệ.' });

    const conditions = [];
    const values = [];
    if (date) {
      values.push(date);
      conditions.push(`date = $${values.length}`);
    }
    if (from) {
      values.push(from);
      conditions.push(`date >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`date <= $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(`
      SELECT
        id,
        TO_CHAR(date, 'YYYY-MM-DD') AS date,
        TO_CHAR(time, 'HH24:MI') AS time,
        amount_ml AS "amountMl",
        note,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM milk_entries
      ${where}
      ORDER BY date ASC, time ASC
    `, values);
    res.json(result.rows.map(mapEntry));
  } catch (error) {
    next(error);
  }
});

app.get('/api/summary', async (req, res, next) => {
  try {
    const { date } = req.query;
    if (!validDate(date)) return res.status(400).json({ message: 'Vui lòng truyền date theo định dạng YYYY-MM-DD.' });

    const result = await pool.query(`
      SELECT
        COALESCE(SUM(amount_ml), 0)::INTEGER AS "totalMl",
        COUNT(*)::INTEGER AS count
      FROM milk_entries
      WHERE date = $1
    `, [date]);
    const summary = result.rows[0];
    const totalMl = Number(summary.totalMl);
    const count = Number(summary.count);
    res.json({ date, totalMl, count, averageMl: count ? Math.round(totalMl / count) : 0 });
  } catch (error) {
    next(error);
  }
});

app.post('/api/entries', async (req, res, next) => {
  try {
    const validationError = validateEntry(req.body);
    if (validationError) return res.status(400).json({ message: validationError });

    const payload = normalizePayload(req.body);
    const result = await pool.query(`
      INSERT INTO milk_entries (id, date, time, amount_ml, note)
      VALUES ($1, $2, $3, $4, $5)
      ${entryReturning}
    `, [crypto.randomUUID(), payload.date, payload.time, payload.amountMl, payload.note]);
    res.status(201).json(mapEntry(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/entries/:id', async (req, res, next) => {
  try {
    const validationError = validateEntry(req.body);
    if (validationError) return res.status(400).json({ message: validationError });

    const payload = normalizePayload(req.body);
    const result = await pool.query(`
      UPDATE milk_entries
      SET date = $1, time = $2, amount_ml = $3, note = $4, updated_at = NOW()
      WHERE id = $5
      ${entryReturning}
    `, [payload.date, payload.time, payload.amountMl, payload.note, req.params.id]);

    if (result.rowCount === 0) return res.status(404).json({ message: 'Không tìm thấy lần uống sữa.' });
    res.json(mapEntry(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/entries/:id', async (req, res, next) => {
  try {
    const result = await pool.query(`
      DELETE FROM milk_entries
      WHERE id = $1
      ${entryReturning}
    `, [req.params.id]);

    if (result.rowCount === 0) return res.status(404).json({ message: 'Không tìm thấy lần uống sữa.' });
    res.json({ message: 'Đã xoá lần uống sữa.', entry: mapEntry(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pump-entries', async (req, res, next) => {
  try {
    const { date } = req.query;
    if (date && !validDate(date)) return res.status(400).json({ message: 'Tham số date không hợp lệ.' });
    const result = await pool.query(`
      SELECT
        id,
        TO_CHAR(date, 'YYYY-MM-DD') AS date,
        TO_CHAR(time, 'HH24:MI') AS time,
        side,
        amount_ml AS "amountMl",
        note,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM pump_entries
      ${date ? 'WHERE date = $1' : ''}
      ORDER BY date ASC, time ASC
    `, date ? [date] : []);
    res.json(result.rows.map(mapPumpEntry));
  } catch (error) {
    next(error);
  }
});

app.post('/api/pump-entries', async (req, res, next) => {
  try {
    const validationError = validatePumpEntry(req.body);
    if (validationError) return res.status(400).json({ message: validationError });

    const payload = normalizePumpEntry(req.body);
    const result = await pool.query(`
      INSERT INTO pump_entries (id, date, time, side, amount_ml, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      ${pumpReturning}
    `, [crypto.randomUUID(), payload.date, payload.time, payload.side, payload.amountMl, payload.note]);
    res.status(201).json(mapPumpEntry(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/pump-entries/:id', async (req, res, next) => {
  try {
    const validationError = validatePumpEntry(req.body);
    if (validationError) return res.status(400).json({ message: validationError });

    const payload = normalizePumpEntry(req.body);
    const result = await pool.query(`
      UPDATE pump_entries
      SET date = $1, time = $2, side = $3, amount_ml = $4, note = $5, updated_at = NOW()
      WHERE id = $6
      ${pumpReturning}
    `, [payload.date, payload.time, payload.side, payload.amountMl, payload.note, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Không tìm thấy lần hút sữa.' });
    res.json(mapPumpEntry(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/pump-entries/:id', async (req, res, next) => {
  try {
    const result = await pool.query(`
      DELETE FROM pump_entries
      WHERE id = $1
      ${pumpReturning}
    `, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Không tìm thấy lần hút sữa.' });
    res.json({ message: 'Đã xoá lần hút sữa.', entry: mapPumpEntry(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sleep-entries', async (req, res, next) => {
  try {
    const { date } = req.query;
    if (date && !validDate(date)) return res.status(400).json({ message: 'Tham số date không hợp lệ.' });
    const result = await pool.query(`
      SELECT
        id,
        TO_CHAR(date, 'YYYY-MM-DD') AS date,
        TO_CHAR(start_time, 'HH24:MI') AS "startTime",
        TO_CHAR(end_time, 'HH24:MI') AS "endTime",
        duration_minutes AS "durationMinutes",
        note,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM sleep_entries
      ${date ? 'WHERE date = $1' : ''}
      ORDER BY date ASC, start_time ASC
    `, date ? [date] : []);
    res.json(result.rows.map(mapSleepEntry));
  } catch (error) {
    next(error);
  }
});

app.post('/api/sleep-entries', async (req, res, next) => {
  try {
    const validationError = validateSleepEntry(req.body);
    if (validationError) return res.status(400).json({ message: validationError });

    const payload = normalizeSleepEntry(req.body);
    const result = await pool.query(`
      INSERT INTO sleep_entries (id, date, start_time, end_time, duration_minutes, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      ${sleepReturning}
    `, [crypto.randomUUID(), payload.date, payload.startTime, payload.endTime, payload.durationMinutes, payload.note]);
    res.status(201).json(mapSleepEntry(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/sleep-entries/:id', async (req, res, next) => {
  try {
    const validationError = validateSleepEntry(req.body);
    if (validationError) return res.status(400).json({ message: validationError });

    const payload = normalizeSleepEntry(req.body);
    const result = await pool.query(`
      UPDATE sleep_entries
      SET date = $1, start_time = $2, end_time = $3, duration_minutes = $4, note = $5, updated_at = NOW()
      WHERE id = $6
      ${sleepReturning}
    `, [payload.date, payload.startTime, payload.endTime, payload.durationMinutes, payload.note, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Không tìm thấy giấc ngủ.' });
    res.json(mapSleepEntry(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/sleep-entries/:id', async (req, res, next) => {
  try {
    const result = await pool.query(`
      DELETE FROM sleep_entries
      WHERE id = $1
      ${sleepReturning}
    `, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Không tìm thấy giấc ngủ.' });
    res.json({ message: 'Đã xoá giấc ngủ.', entry: mapSleepEntry(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => {
  res.status(404).json({ message: 'Không tìm thấy tài nguyên.' });
});

app.use((error, _req, res, _next) => {
  const details = [error?.code, error?.message, error?.detail, error?.hint].filter(Boolean).join(' | ');
  console.error(details || error || 'Lỗi máy chủ không xác định.');
  res.status(error?.message === 'Origin không được phép truy cập API.' ? 403 : 500).json({
    message: process.env.NODE_ENV === 'development'
      ? details || 'Lỗi máy chủ không xác định.'
      : 'Đã xảy ra lỗi máy chủ.',
  });
});

async function connectDatabase() {
  try {
    await initializeDatabase();
    databaseReady = true;
    databaseError = null;
    console.log(`PostgreSQL đã sẵn sàng: ${databaseUrl ? 'DATABASE_URL' : `${databaseHost}:${databasePort}/${databaseName}`} (SSL: ${databaseSsl ? 'on' : 'off'})`);
  } catch (error) {
    databaseReady = false;
    databaseError = error;
    const details = [error.code, error.message, error.detail, error.hint].filter(Boolean).join(' | ');
    console.error('Không thể khởi động API hoặc kết nối PostgreSQL:', details || error);
    databaseRetryTimer = setTimeout(connectDatabase, 5000);
  }
}

function start() {
  server = app.listen(port, () => {
    console.log(`MIA Milk Tracker API đang chạy tại http://localhost:${port}`);
    console.log(`Database target: ${databaseUrl ? 'DATABASE_URL' : `${databaseHost}:${databasePort}/${databaseName}`} (SSL: ${databaseSsl ? 'on' : 'off'})`);
  });
  connectDatabase();
}

async function shutdown(signal) {
  console.log(`Nhận ${signal}, đang đóng MIA Milk Tracker API...`);
  clearTimeout(databaseRetryTimer);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();

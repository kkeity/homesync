'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) dotenv.config({ path: path.join(__dirname, '_env') });

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
    console.error('Missing DATABASE_URL or JWT_SECRET. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'hs_token';
const SESSION_HOURS = 8;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin'
    });
    next();
});

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

const pad = n => String(n).padStart(2, '0');
const blank = v => v === undefined || v === null || String(v).trim() === '' || v === 'null';
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function intParam(v) {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1 || String(n) !== String(v).trim()) throw httpError(400, 'Invalid id.');
    return n;
}

function periodOf(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function shiftPeriod(period, offset) {
    const [y, m] = period.split('-').map(Number);
    return periodOf(new Date(y, m - 1 + offset, 1));
}

async function withTx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function audit(req, userId, action) {
    try {
        await pool.query(
            'INSERT INTO audit_logs (user_id, action, endpoint, ip_address) VALUES ($1,$2,$3,$4)',
            [userId, action.slice(0, 100), `${req.method} ${req.originalUrl}`.slice(0, 150), String(req.ip || '').slice(0, 45)]
        );
    } catch (err) {
        console.error('Audit log failed:', err.message);
    }
}

async function notify(userIds, message, type) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
    for (const id of ids) {
        try {
            await pool.query('INSERT INTO notifications (user_id, message, event_type) VALUES ($1,$2,$3)', [id, message.slice(0, 500), type]);
        } catch (err) {
            console.error('Notification failed:', err.message);
        }
    }
}

async function userIdsByRole(role) {
    const r = await pool.query('SELECT id FROM users WHERE role = $1', [role]);
    return r.rows.map(x => x.id);
}

const publicUser = u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || '',
    role: u.role.toLowerCase()
});

function getCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

function setSession(res, user) {
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PROD,
        maxAge: SESSION_HOURS * 3600 * 1000
    });
}

async function auth(req, res, next) {
    const token = getCookie(req, COOKIE_NAME);
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
    }
    const r = await pool.query('SELECT id, name, email, phone, role FROM users WHERE id = $1', [payload.id]);
    if (!r.rows.length) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = r.rows[0];
    next();
}

const requireRole = (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have access to this.' });

async function verifyPassword(plain, stored) {
    if (/^\$2[aby]\$/.test(stored)) return bcrypt.compare(plain, stored);
    return plain === stored; 
}

const loginAttempts = new Map();
function loginBlocked(key) {
    const now = Date.now();
    const rec = loginAttempts.get(key);
    if (!rec || now - rec.start > 15 * 60 * 1000) return false;
    return rec.count >= 10;
}
function loginFailed(key) {
    const now = Date.now();
    const rec = loginAttempts.get(key);
    if (!rec || now - rec.start > 15 * 60 * 1000) loginAttempts.set(key, { count: 1, start: now });
    else rec.count++;
}

app.post('/api/auth/login', async (req, res) => {
    const email = clean(req.body?.email, 100).toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!email || !password) throw httpError(400, 'Enter your email and password.');

    const key = `${req.ip}|${email}`;
    if (loginBlocked(key)) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');

    const r = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
    const user = r.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
        loginFailed(key);
        throw httpError(401, 'Invalid email or password.');
    }
    loginAttempts.delete(key);

    if (!/^\$2[aby]\$/.test(user.password_hash)) {
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(password, 10), user.id]);
    }

    setSession(res, user);
    await audit(req, user.id, 'USER_LOGIN');
    res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/auth/profile', auth, async (req, res) => {
    const name = clean(req.body?.name, 100);
    const email = clean(req.body?.email, 100).toLowerCase();
    const phone = clean(req.body?.phone, 30);
    if (!name) throw httpError(400, 'Name is required.');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');

    const dup = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2', [email, req.user.id]);
    if (dup.rows.length) throw httpError(409, 'That email is already in use.');

    const r = await pool.query(
        'UPDATE users SET name=$1, email=$2, phone=$3 WHERE id=$4 RETURNING id, name, email, phone, role',
        [name, email, phone || null, req.user.id]
    );
    await audit(req, req.user.id, 'PROFILE_UPDATED');
    res.json({ user: publicUser(r.rows[0]) });
});

app.post('/api/auth/password', auth, async (req, res) => {
    const { current, next } = req.body || {};
    if (String(next ?? '').length < 8) throw httpError(400, 'New password must be at least 8 characters.');
    const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(String(current ?? ''), r.rows[0].password_hash))) {
        throw httpError(400, 'Current password is incorrect.');
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(String(next), 10), req.user.id]);
    await audit(req, req.user.id, 'PASSWORD_CHANGED');
    res.json({ ok: true });
});

const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const KINDS = ['receipts', 'photos', 'documents'];
KINDS.forEach(k => fs.mkdirSync(path.join(UPLOAD_ROOT, k), { recursive: true }));

const IMAGE_TYPES = { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'] };
const RECEIPT_TYPES = { ...IMAGE_TYPES, 'application/pdf': ['.pdf'] };
const DOC_TYPES = {
    ...RECEIPT_TYPES,
    'application/msword': ['.doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
};

function makeUpload(kind, allowed, maxMB, label) {
    return multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, kind)),
            filename: (req, file, cb) =>
                cb(null, `${kind}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
        }),
        limits: { fileSize: maxMB * 1024 * 1024, files: 1 },
        fileFilter: (req, file, cb) => {
            const exts = allowed[file.mimetype];
            if (exts && exts.includes(path.extname(file.originalname).toLowerCase())) return cb(null, true);
            cb(httpError(400, `Unsupported file. Allowed: ${label}.`));
        }
    });
}

const receiptUpload = makeUpload('receipts', RECEIPT_TYPES, 5, 'JPG, PNG, WEBP or PDF up to 5 MB');
const photoUpload = makeUpload('photos', IMAGE_TYPES, 5, 'JPG, PNG or WEBP up to 5 MB');
const documentUpload = makeUpload('documents', DOC_TYPES, 10, 'PDF, JPG, PNG, WEBP, DOC or DOCX up to 10 MB');

function storedPath(stored) {
    const parts = String(stored || '').split('/').filter(Boolean);
    const kind = KINDS.find(k => parts.includes(k));
    if (!kind) return null;
    return path.join(UPLOAD_ROOT, kind, path.basename(parts[parts.length - 1]));
}

function removeStored(stored) {
    const p = storedPath(stored);
    if (p) fs.unlink(p, () => {});
}

const storedName = (kind, file) => `${kind}/${file.filename}`;

function sendStored(res, stored, downloadName) {
    const p = storedPath(stored);
    if (!p || !fs.existsSync(p)) throw httpError(404, 'File not found.');
    if (downloadName) return res.download(p, downloadName);
    res.sendFile(p, { dotfiles: 'allow' });
}

const STATUS_MAP = {
    Submitted: 'PENDING', Pending: 'PENDING', 'In Progress': 'IN_PROGRESS', Completed: 'RESOLVED', Resolved: 'RESOLVED',
    PENDING: 'PENDING', IN_PROGRESS: 'IN_PROGRESS', RESOLVED: 'RESOLVED'
};
const STATUS_TEXT = { PENDING: 'Submitted', IN_PROGRESS: 'In Progress', RESOLVED: 'Completed' };
const PRIORITY_MAP = { NORMAL: 'MEDIUM', MEDIUM: 'MEDIUM', LOW: 'LOW', HIGH: 'HIGH', URGENT: 'URGENT' };
const CATEGORIES = ['Plumbing', 'Electrical', 'Appliance', 'Cleaning', 'Other'];

const TICKET_SQL = `
    SELECT t.id, t.title, t.category, t.priority, t.description, t.status, t.created_at, t.updated_at,
           t.resolution_note, (t.photo_url IS NOT NULL) AS has_photo, t.tenant_id, t.assigned_staff_id,
           u.name AS tenant, p.unit_number AS unit, p.building, s.name AS staff
    FROM tickets t
    JOIN users u ON u.id = t.tenant_id
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN users s ON s.id = t.assigned_staff_id`;

function ticketScope(user) {
    if (user.role === 'TENANT') return { where: 't.tenant_id = $1', params: [user.id] };
    if (user.role === 'MAINTENANCE') return { where: 't.assigned_staff_id = $1', params: [user.id] };
    return { where: 'TRUE', params: [] };
}

async function listTickets(user, limit) {
    const sc = ticketScope(user);
    const r = await pool.query(
        `${TICKET_SQL} WHERE ${sc.where} ORDER BY t.id DESC ${limit ? `LIMIT ${Number(limit)}` : ''}`,
        sc.params
    );
    return r.rows;
}

async function getTicket(user, id) {
    const sc = ticketScope(user);
    const params = [...sc.params, id];
    const r = await pool.query(`${TICKET_SQL} WHERE ${sc.where} AND t.id = $${params.length}`, params);
    return r.rows[0] || null;
}

const PAYMENT_SQL = `
    SELECT p.id, p.reference_id, p.amount::float8 AS amount, p.status, p.period, p.method, p.external_ref,
           p.review_note, p.created_at, p.reviewed_at, p.tenant_id, u.name AS tenant, pr.unit_number AS unit
    FROM payments p
    LEFT JOIN users u ON u.id = p.tenant_id
    LEFT JOIN properties pr ON pr.id = (SELECT property_id FROM leases WHERE tenant_id = p.tenant_id ORDER BY id DESC LIMIT 1)`;

const DOC_SQL = `
    SELECT d.id, d.title, d.category, d.file_name, d.size_bytes, d.tenant_id, d.uploaded_by, d.created_at,
           tu.name AS tenant, up.name AS uploader, up.role AS uploader_role
    FROM documents d
    LEFT JOIN users tu ON tu.id = d.tenant_id
    LEFT JOIN users up ON up.id = d.uploaded_by`;

async function tenantContext(userId) {
    const l = await pool.query(
        `SELECT l.id AS lease_id, to_char(l.start_date,'YYYY-MM-DD') AS start_date, to_char(l.end_date,'YYYY-MM-DD') AS end_date,
                l.monthly_rent::float8 AS monthly_rent, p.id AS property_id, p.unit_number, p.building
         FROM leases l JOIN properties p ON p.id = l.property_id
         WHERE l.tenant_id = $1 AND l.status = 'ACTIVE' ORDER BY l.id DESC LIMIT 1`,
        [userId]
    );
    if (l.rows[0]) return l.rows[0];
    const p = await pool.query('SELECT id AS property_id, unit_number, building FROM properties WHERE tenant_id = $1 LIMIT 1', [userId]);
    return p.rows[0] || null;
}

app.get('/api/overview', auth, async (req, res) => {
    const period = periodOf();
    const overdue = new Date().getDate() > 5;

    if (req.user.role === 'TENANT') {
        const ctx = await tenantContext(req.user.id);
        const pay = await pool.query(
            `SELECT id, status, amount::float8 AS amount FROM payments
             WHERE tenant_id = $1 AND period = $2 AND status <> 'REJECTED' ORDER BY id DESC LIMIT 1`,
            [req.user.id, period]
        );
        const periodPayment = pay.rows[0] || null;
        const tickets = await listTickets(req.user);
        const nextPeriod = periodPayment ? shiftPeriod(period, 1) : period;
        return res.json({
            role: 'tenant',
            period,
            overdue: !periodPayment && overdue,
            lease: ctx,
            periodPayment,
            nextDue: `${nextPeriod}-01`,
            tickets: {
                open: tickets.filter(t => t.status !== 'RESOLVED').length,
                resolved: tickets.filter(t => t.status === 'RESOLVED').length,
                recent: tickets.slice(0, 4)
            }
        });
    }

    if (req.user.role === 'MAINTENANCE') {
        const tickets = await listTickets(req.user);
        return res.json({
            role: 'maintenance',
            assigned: tickets.filter(t => t.status === 'PENDING').length,
            inProgress: tickets.filter(t => t.status === 'IN_PROGRESS').length,
            resolved: tickets.filter(t => t.status === 'RESOLVED').length,
            recent: tickets.filter(t => t.status !== 'RESOLVED').slice(0, 5)
        });
    }

    const [units, tenants, tix, pays, lease, unpaid, recent, pending] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS total, COUNT(tenant_id)::int AS occupied FROM properties'),
        pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'TENANT'`),
        pool.query(`SELECT COUNT(*) FILTER (WHERE status <> 'RESOLVED')::int AS open,
                           COUNT(*) FILTER (WHERE status <> 'RESOLVED' AND priority = 'URGENT')::int AS urgent,
                           COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved FROM tickets`),
        pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                           COALESCE(SUM(amount) FILTER (WHERE status = 'VERIFIED' AND period = $1), 0)::float8 AS collected FROM payments`, [period]),
        pool.query(`SELECT COALESCE(SUM(monthly_rent), 0)::float8 AS expected FROM leases WHERE status = 'ACTIVE'`),
        pool.query(`SELECT COUNT(*)::int AS n FROM leases l WHERE l.status = 'ACTIVE' AND NOT EXISTS
                    (SELECT 1 FROM payments p WHERE p.tenant_id = l.tenant_id AND p.period = $1 AND p.status <> 'REJECTED')`, [period]),
        listTickets(req.user, 5),
        pool.query(`${PAYMENT_SQL} WHERE p.status = 'PENDING' ORDER BY p.created_at DESC LIMIT 5`)
    ]);
    res.json({
        role: 'landlord',
        period,
        units: units.rows[0],
        tenants: tenants.rows[0].n,
        tickets: tix.rows[0],
        payments: { ...pays.rows[0], expected: lease.rows[0].expected, unpaid: unpaid.rows[0].n },
        recentTickets: recent,
        pendingPayments: pending.rows
    });
});

app.get('/api/tickets', auth, async (req, res) => {
    res.json(await listTickets(req.user));
});

app.post('/api/tickets', auth, requireRole('TENANT'), photoUpload.single('photo'), async (req, res) => {
    const title = clean(req.body?.title, 150);
    const category = clean(req.body?.category, 50);
    const priority = PRIORITY_MAP[String(req.body?.priority || 'MEDIUM').toUpperCase()];
    const description = clean(req.body?.description, 3000);

    if (!title || !description) throw httpError(400, 'Title and description are required.');
    if (!CATEGORIES.includes(category)) throw httpError(400, 'Choose a valid category.');
    if (!priority) throw httpError(400, 'Choose a valid priority.');

    const ctx = await tenantContext(req.user.id);
    if (!ctx) throw httpError(400, 'You are not assigned to a unit yet. Please contact your landlord.');

    const r = await pool.query(
        `INSERT INTO tickets (tenant_id, property_id, title, category, priority, description, photo_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING') RETURNING id`,
        [req.user.id, ctx.property_id, title, category, priority, description, req.file ? storedName('photos', req.file) : null]
    );
    await notify(await userIdsByRole('LANDLORD'),
        `New ${priority.toLowerCase()} request from ${req.user.name} (Unit ${ctx.unit_number}): ${title}`, 'TICKET_CREATED');
    await audit(req, req.user.id, 'TICKET_CREATED');
    res.status(201).json(await getTicket(req.user, r.rows[0].id));
});

app.patch('/api/tickets/:id', auth, requireRole('LANDLORD', 'MAINTENANCE'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = req.body || {};
    const existing = await getTicket(req.user, id);
    if (!existing) throw httpError(404, 'Request not found.');

    const sets = [];
    const vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    let newStatus = null;
    let newStaff = null;

    if (b.status !== undefined) {
        newStatus = STATUS_MAP[b.status];
        if (!newStatus) throw httpError(400, `Invalid status: ${b.status}`);
        add('status', newStatus);
    }
    if (b.resolution_note !== undefined) add('resolution_note', clean(b.resolution_note, 2000) || null);

    if (req.user.role === 'LANDLORD') {
        if (b.priority !== undefined) {
            const pr = PRIORITY_MAP[String(b.priority).toUpperCase()];
            if (!pr) throw httpError(400, 'Invalid priority.');
            add('priority', pr);
        }
        if (b.assigned_staff_id !== undefined) {
            if (blank(b.assigned_staff_id)) {
                add('assigned_staff_id', null);
            } else {
                newStaff = intParam(b.assigned_staff_id);
                const s = await pool.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'MAINTENANCE'`, [newStaff]);
                if (!s.rows.length) throw httpError(400, 'Selected staff member not found.');
                add('assigned_staff_id', newStaff);
                if (newStatus === null && existing.status === 'PENDING') {
                    newStatus = 'IN_PROGRESS';
                    add('status', newStatus);
                }
            }
        }
    }

    if (!sets.length) throw httpError(400, 'Nothing to update.');
    sets.push('updated_at = NOW()');
    vals.push(id);
    await pool.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);

    if (newStatus && newStatus !== existing.status) {
        await notify(existing.tenant_id, `Your request "${existing.title}" is now ${STATUS_TEXT[newStatus]}.`, 'TICKET_STATUS');
        if (req.user.role === 'MAINTENANCE') {
            await notify(await userIdsByRole('LANDLORD'), `${req.user.name} marked "${existing.title}" as ${STATUS_TEXT[newStatus]}.`, 'TICKET_STATUS');
        }
    }
    if (newStaff && newStaff !== existing.assigned_staff_id) {
        await notify(newStaff, `You were assigned: ${existing.title} (Unit ${existing.unit || '?'})`, 'TICKET_ASSIGNED');
    }
    await audit(req, req.user.id, 'TICKET_UPDATED');

   
    const updated = await getTicket(req.user.role === 'LANDLORD' ? req.user : { ...req.user, role: 'LANDLORD' }, id);
    res.json(updated);
});

app.get('/api/tickets/:id/photo', auth, async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await getTicket(req.user, id))) throw httpError(404, 'Request not found.');
    const r = await pool.query('SELECT photo_url FROM tickets WHERE id = $1', [id]);
    if (!r.rows[0]?.photo_url) throw httpError(404, 'No photo attached.');
    sendStored(res, r.rows[0].photo_url);
});

app.get('/api/staff', auth, requireRole('LANDLORD'), async (req, res) => {
    const r = await pool.query(
        `SELECT u.id, u.name, u.email, u.phone,
                (SELECT COUNT(*)::int FROM tickets t WHERE t.assigned_staff_id = u.id AND t.status <> 'RESOLVED') AS open_tickets
         FROM users u WHERE u.role = 'MAINTENANCE' ORDER BY u.name`
    );
    res.json(r.rows);
});

app.post('/api/staff', auth, requireRole('LANDLORD'), async (req, res) => {
    const name = clean(req.body?.name, 100);
    const email = clean(req.body?.email, 100).toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!name) throw httpError(400, 'Name is required.');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    if ((await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email])).rows.length) throw httpError(409, 'That email is already in use.');

    const r = await pool.query(
        `INSERT INTO users (name, email, password_hash, role, phone) VALUES ($1,$2,$3,'MAINTENANCE',$4) RETURNING id, name, email`,
        [name, email, await bcrypt.hash(password, 10), clean(req.body?.phone, 30) || null]
    );
    await audit(req, req.user.id, 'STAFF_CREATED');
    res.status(201).json(r.rows[0]);
});

app.get('/api/properties', auth, requireRole('LANDLORD'), async (req, res) => {
    const r = await pool.query(
        `SELECT p.id, p.unit_number, p.building, p.tenant_id, u.name AS tenant,
                l.monthly_rent::float8 AS monthly_rent, l.end_date,
                (SELECT COUNT(*)::int FROM tickets t WHERE t.property_id = p.id AND t.status <> 'RESOLVED') AS open_tickets
         FROM properties p
         LEFT JOIN users u ON u.id = p.tenant_id
         LEFT JOIN LATERAL (SELECT monthly_rent, to_char(end_date,'YYYY-MM-DD') AS end_date FROM leases
                            WHERE property_id = p.id AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1) l ON TRUE
         ORDER BY p.building, p.unit_number`
    );
    res.json(r.rows);
});

async function assertUnitFree(unit, building, exceptId = 0) {
    const d = await pool.query(
        'SELECT 1 FROM properties WHERE LOWER(unit_number) = LOWER($1) AND LOWER(building) = LOWER($2) AND id <> $3',
        [unit, building, exceptId]
    );
    if (d.rows.length) throw httpError(409, 'That unit already exists in this building.');
}

app.post('/api/properties', auth, requireRole('LANDLORD'), async (req, res) => {
    const unit = clean(req.body?.unit_number, 50);
    const building = clean(req.body?.building, 50);
    if (!unit || !building) throw httpError(400, 'Building and unit number are required.');
    await assertUnitFree(unit, building);
    const r = await pool.query(
        'INSERT INTO properties (unit_number, building, landlord_id) VALUES ($1,$2,$3) RETURNING id',
        [unit, building, req.user.id]
    );
    await audit(req, req.user.id, 'PROPERTY_CREATED');
    res.status(201).json({ id: r.rows[0].id });
});

app.patch('/api/properties/:id', auth, requireRole('LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    const unit = clean(req.body?.unit_number, 50);
    const building = clean(req.body?.building, 50);
    if (!unit || !building) throw httpError(400, 'Building and unit number are required.');
    await assertUnitFree(unit, building, id);
    const r = await pool.query('UPDATE properties SET unit_number = $1, building = $2 WHERE id = $3 RETURNING id', [unit, building, id]);
    if (!r.rows.length) throw httpError(404, 'Unit not found.');
    await audit(req, req.user.id, 'PROPERTY_UPDATED');
    res.json({ id });
});

app.delete('/api/properties/:id', auth, requireRole('LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    const p = await pool.query('SELECT tenant_id FROM properties WHERE id = $1', [id]);
    if (!p.rows.length) throw httpError(404, 'Unit not found.');
    if (p.rows[0].tenant_id) throw httpError(409, 'This unit has a tenant. End the lease first.');
    try {
        await pool.query('DELETE FROM properties WHERE id = $1', [id]);
    } catch (err) {
        if (err.code === '23503') throw httpError(409, 'This unit has leases or maintenance history and cannot be deleted.');
        throw err;
    }
    await audit(req, req.user.id, 'PROPERTY_DELETED');
    res.json({ ok: true });
});

app.get('/api/tenants', auth, requireRole('LANDLORD'), async (req, res) => {
    const r = await pool.query(
        `SELECT u.id, u.name, u.email, u.phone, u.created_at,
                p.id AS property_id, p.unit_number, p.building,
                l.id AS lease_id, l.monthly_rent::float8 AS monthly_rent,
                to_char(l.start_date,'YYYY-MM-DD') AS start_date, to_char(l.end_date,'YYYY-MM-DD') AS end_date,
                (SELECT status FROM payments WHERE tenant_id = u.id AND period = $1 AND status <> 'REJECTED' ORDER BY id DESC LIMIT 1) AS period_payment
         FROM users u
         LEFT JOIN LATERAL (SELECT * FROM leases WHERE tenant_id = u.id AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1) l ON TRUE
         LEFT JOIN properties p ON p.id = COALESCE(l.property_id, (SELECT id FROM properties WHERE tenant_id = u.id LIMIT 1))
         WHERE u.role = 'TENANT' ORDER BY u.name`,
        [periodOf()]
    );
    res.json(r.rows);
});

function parseLease(b) {
    const property_id = intParam(b.property_id);
    const rent = Number(b.monthly_rent);
    if (!(rent > 0) || rent > 10000000) throw httpError(400, 'Enter a valid monthly rent.');
    if (!DATE_RE.test(String(b.start_date)) || !DATE_RE.test(String(b.end_date))) throw httpError(400, 'Enter valid lease start and end dates.');
    if (b.end_date <= b.start_date) throw httpError(400, 'Lease end date must be after the start date.');
    return { property_id, monthly_rent: rent.toFixed(2), start_date: b.start_date, end_date: b.end_date };
}

async function createLease(client, tenantId, lease) {
    const prop = await client.query('SELECT tenant_id, unit_number FROM properties WHERE id = $1 FOR UPDATE', [lease.property_id]);
    if (!prop.rows.length) throw httpError(404, 'Unit not found.');
    if (prop.rows[0].tenant_id) throw httpError(409, 'That unit is already occupied.');
    const active = await client.query(`SELECT 1 FROM leases WHERE tenant_id = $1 AND status = 'ACTIVE'`, [tenantId]);
    if (active.rows.length) throw httpError(409, 'This tenant already has an active lease.');
    await client.query(
        `INSERT INTO leases (tenant_id, property_id, start_date, end_date, monthly_rent, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')`,
        [tenantId, lease.property_id, lease.start_date, lease.end_date, lease.monthly_rent]
    );
    await client.query('UPDATE properties SET tenant_id = $1 WHERE id = $2', [tenantId, lease.property_id]);
    return prop.rows[0].unit_number;
}

app.post('/api/tenants', auth, requireRole('LANDLORD'), async (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 100);
    const email = clean(b.email, 100).toLowerCase();
    const password = String(b.password ?? '');
    if (!name) throw httpError(400, 'Name is required.');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
    if (password.length < 8) throw httpError(400, 'Temporary password must be at least 8 characters.');
    const lease = blank(b.property_id) ? null : parseLease(b);
    if ((await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email])).rows.length) throw httpError(409, 'That email is already in use.');

    const hash = await bcrypt.hash(password, 10);
    const id = await withTx(async client => {
        const u = await client.query(
            `INSERT INTO users (name, email, password_hash, role, phone) VALUES ($1,$2,$3,'TENANT',$4) RETURNING id`,
            [name, email, hash, clean(b.phone, 30) || null]
        );
        if (lease) await createLease(client, u.rows[0].id, lease);
        return u.rows[0].id;
    });
    await notify(id, 'Welcome to HomeSync! You can now submit requests and pay rent here.', 'WELCOME');
    await audit(req, req.user.id, 'TENANT_CREATED');
    res.status(201).json({ id });
});

app.patch('/api/tenants/:id', auth, requireRole('LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = req.body || {};
    const name = clean(b.name, 100);
    const email = clean(b.email, 100).toLowerCase();
    if (!name) throw httpError(400, 'Name is required.');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
    if (!(await pool.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'TENANT'`, [id])).rows.length) throw httpError(404, 'Tenant not found.');
    if ((await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2', [email, id])).rows.length) throw httpError(409, 'That email is already in use.');

    await pool.query('UPDATE users SET name = $1, email = $2, phone = $3 WHERE id = $4', [name, email, clean(b.phone, 30) || null, id]);
    if (!blank(b.password)) {
        if (String(b.password).length < 8) throw httpError(400, 'Password must be at least 8 characters.');
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(String(b.password), 10), id]);
    }
    await audit(req, req.user.id, 'TENANT_UPDATED');
    res.json({ id });
});

app.post('/api/tenants/:id/lease', auth, requireRole('LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await pool.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'TENANT'`, [id])).rows.length) throw httpError(404, 'Tenant not found.');
    const lease = parseLease(req.body || {});
    const unit = await withTx(client => createLease(client, id, lease));
    await notify(id, `Your lease for Unit ${unit} is now active.`, 'LEASE');
    await audit(req, req.user.id, 'LEASE_CREATED');
    res.status(201).json({ ok: true });
});

app.post('/api/tenants/:id/end-lease', auth, requireRole('LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    await withTx(async client => {
        await client.query(`UPDATE leases SET status = 'ENDED' WHERE tenant_id = $1 AND status = 'ACTIVE'`, [id]);
        await client.query('UPDATE properties SET tenant_id = NULL WHERE tenant_id = $1', [id]);
    });
    await notify(id, 'Your lease has been ended by the property manager.', 'LEASE');
    await audit(req, req.user.id, 'LEASE_ENDED');
    res.json({ ok: true });
});

app.patch('/api/leases/:id', auth, requireRole('LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    const b = req.body || {};
    const rent = Number(b.monthly_rent);
    if (!(rent > 0) || rent > 10000000) throw httpError(400, 'Enter a valid monthly rent.');
    if (!DATE_RE.test(String(b.start_date)) || !DATE_RE.test(String(b.end_date)) || b.end_date <= b.start_date) {
        throw httpError(400, 'Enter valid lease dates (end must be after start).');
    }
    const r = await pool.query(
        'UPDATE leases SET monthly_rent = $1, start_date = $2, end_date = $3 WHERE id = $4 RETURNING tenant_id',
        [rent.toFixed(2), b.start_date, b.end_date, id]
    );
    if (!r.rows.length) throw httpError(404, 'Lease not found.');
    await notify(r.rows[0].tenant_id, 'Your lease terms were updated. Check the Payments page for the new rent.', 'LEASE');
    await audit(req, req.user.id, 'LEASE_UPDATED');
    res.json({ ok: true });
});

const METHODS = ['GCash', 'Maya', 'Bank Transfer', 'Cash', 'Other'];

app.get('/api/payments', auth, requireRole('TENANT', 'LANDLORD'), async (req, res) => {
    const tenantOnly = req.user.role === 'TENANT';
    const r = await pool.query(
        `${PAYMENT_SQL} ${tenantOnly ? 'WHERE p.tenant_id = $1' : ''} ORDER BY p.created_at DESC`,
        tenantOnly ? [req.user.id] : []
    );
    res.json(r.rows);
});

app.post('/api/payments', auth, requireRole('TENANT'), receiptUpload.single('receipt'), async (req, res) => {
    const file = req.file;
    const discard = msg => { if (file) removeStored(storedName('receipts', file)); return httpError(400, msg); };

    if (!file) throw httpError(400, 'Please attach your payment receipt.');
    const period = blank(req.body?.period) ? periodOf() : String(req.body.period);
    const method = clean(req.body?.method, 30);
    if (!PERIOD_RE.test(period)) throw discard('Choose a valid billing month.');
    if (!METHODS.includes(method)) throw discard('Choose a payment method.');

    const ctx = await tenantContext(req.user.id);
    if (!ctx || !ctx.monthly_rent) throw discard('You have no active lease, so there is no rent to pay.');

    const dup = await pool.query(
        `SELECT 1 FROM payments WHERE tenant_id = $1 AND period = $2 AND status IN ('PENDING','VERIFIED')`,
        [req.user.id, period]
    );
    if (dup.rows.length) {
        removeStored(storedName('receipts', file));
        throw httpError(409, 'A payment for that month is already submitted or verified.');
    }

    const referenceId = `HS-${period.replace('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const r = await pool.query(
        `INSERT INTO payments (tenant_id, reference_id, amount, receipt_url, status, period, method, external_ref)
         VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7) RETURNING id`,
        [req.user.id, referenceId, ctx.monthly_rent, storedName('receipts', file), period, method, clean(req.body?.external_ref, 80) || null]
    );
    await notify(await userIdsByRole('LANDLORD'),
        `${req.user.name} (Unit ${ctx.unit_number}) submitted a ${period} rent receipt for verification.`, 'PAYMENT_SUBMITTED');
    await audit(req, req.user.id, 'PAYMENT_SUBMITTED');
    const out = await pool.query(`${PAYMENT_SQL} WHERE p.id = $1`, [r.rows[0].id]);
    res.status(201).json(out.rows[0]);
});

app.patch('/api/payments/:id', auth, requireRole('LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    const status = String(req.body?.status || '').toUpperCase();
    const note = clean(req.body?.note, 500);
    if (!['VERIFIED', 'REJECTED'].includes(status)) throw httpError(400, 'Status must be VERIFIED or REJECTED.');
    if (status === 'REJECTED' && !note) throw httpError(400, 'Please give a reason for rejecting this payment.');

    const r = await pool.query(
        `UPDATE payments SET status = $1, review_note = $2, reviewed_at = NOW() WHERE id = $3 RETURNING tenant_id, period`,
        [status, note || null, id]
    );
    if (!r.rows.length) throw httpError(404, 'Payment not found.');
    await notify(
        r.rows[0].tenant_id,
        status === 'VERIFIED'
            ? `Your ${r.rows[0].period} rent payment was verified. Thank you!`
            : `Your ${r.rows[0].period} rent receipt was rejected: ${note}`,
        status === 'VERIFIED' ? 'PAYMENT_VERIFIED' : 'PAYMENT_REJECTED'
    );
    await audit(req, req.user.id, `PAYMENT_${status}`);
    const out = await pool.query(`${PAYMENT_SQL} WHERE p.id = $1`, [id]);
    res.json(out.rows[0]);
});

app.get('/api/payments/:id/receipt', auth, requireRole('TENANT', 'LANDLORD'), async (req, res) => {
    const id = intParam(req.params.id);
    const r = await pool.query('SELECT tenant_id, receipt_url FROM payments WHERE id = $1', [id]);
    const row = r.rows[0];
    if (!row || (req.user.role === 'TENANT' && row.tenant_id !== req.user.id)) throw httpError(404, 'Receipt not found.');
    sendStored(res, row.receipt_url);
});

const DOC_CATEGORIES = ['LEASE', 'NOTICE', 'RULES', 'ID', 'OTHER'];

app.get('/api/documents', auth, requireRole('TENANT', 'LANDLORD'), async (req, res) => {
    const tenant = req.user.role === 'TENANT';
    const r = await pool.query(
        `${DOC_SQL} ${tenant ? 'WHERE d.tenant_id = $1 OR d.tenant_id IS NULL' : ''} ORDER BY d.created_at DESC`,
        tenant ? [req.user.id] : []
    );
    res.json(r.rows);
});

app.post('/api/documents', auth, requireRole('TENANT', 'LANDLORD'), documentUpload.single('file'), async (req, res) => {
    const file = req.file;
    const discard = (status, msg) => { if (file) removeStored(storedName('documents', file)); return httpError(status, msg); };
    if (!file) throw httpError(400, 'Please choose a file.');

    const category = DOC_CATEGORIES.includes(req.body?.category) ? req.body.category : 'OTHER';
    const title = clean(req.body?.title, 150) || clean(file.originalname, 150);
    let tenantId;

    if (req.user.role === 'TENANT') {
        tenantId = req.user.id;
    } else if (blank(req.body?.tenant_id) || req.body.tenant_id === 'all') {
        tenantId = null;
    } else {
        tenantId = intParam(req.body.tenant_id);
        if (!(await pool.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'TENANT'`, [tenantId])).rows.length) {
            throw discard(400, 'Selected tenant not found.');
        }
    }

    const r = await pool.query(
        `INSERT INTO documents (tenant_id, uploaded_by, title, category, file_name, file_url, size_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [tenantId, req.user.id, title, category, clean(file.originalname, 255), storedName('documents', file), file.size]
    );

    if (req.user.role === 'LANDLORD') {
        const targets = tenantId ? [tenantId] : await userIdsByRole('TENANT');
        await notify(targets, `New document shared with you: ${title}`, 'DOCUMENT');
    } else {
        await notify(await userIdsByRole('LANDLORD'), `${req.user.name} uploaded a document: ${title}`, 'DOCUMENT');
    }
    await audit(req, req.user.id, 'DOCUMENT_UPLOADED');
    const out = await pool.query(`${DOC_SQL} WHERE d.id = $1`, [r.rows[0].id]);
    res.status(201).json(out.rows[0]);
});

async function accessibleDocument(user, id) {
    const r = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    const d = r.rows[0];
    if (!d) return null;
    if (user.role === 'LANDLORD') return d;
    if (user.role === 'TENANT' && (d.tenant_id === user.id || d.tenant_id === null)) return d;
    return null;
}

app.get('/api/documents/:id/download', auth, requireRole('TENANT', 'LANDLORD'), async (req, res) => {
    const d = await accessibleDocument(req.user, intParam(req.params.id));
    if (!d) throw httpError(404, 'Document not found.');
    sendStored(res, d.file_url, req.query.inline ? null : d.file_name);
});

app.delete('/api/documents/:id', auth, requireRole('TENANT', 'LANDLORD'), async (req, res) => {
    const d = await accessibleDocument(req.user, intParam(req.params.id));
    if (!d) throw httpError(404, 'Document not found.');
    if (req.user.role === 'TENANT' && d.uploaded_by !== req.user.id) throw httpError(403, 'You can only delete files you uploaded.');
    await pool.query('DELETE FROM documents WHERE id = $1', [d.id]);
    removeStored(d.file_url);
    await audit(req, req.user.id, 'DOCUMENT_DELETED');
    res.json({ ok: true });
});

app.get('/api/notifications', auth, async (req, res) => {
    const [items, unread] = await Promise.all([
        pool.query('SELECT id, message, event_type, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [req.user.id]),
        pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.id])
    ]);
    res.json({ items: items.rows, unread: unread.rows[0].n });
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [intParam(req.params.id), req.user.id]);
    res.json({ ok: true });
});

app.get('/api/reports', auth, requireRole('LANDLORD'), async (req, res) => {
    const period = periodOf();
    const since = shiftPeriod(period, -5);

    const [monthly, byStatus, byCategory, byPriority, units, rent, res_time, logs] = await Promise.all([
        pool.query(
            `SELECT period, COALESCE(SUM(amount) FILTER (WHERE status = 'VERIFIED'), 0)::float8 AS collected,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0)::float8 AS pending
             FROM payments WHERE period >= $1 GROUP BY period`, [since]),
        pool.query('SELECT status AS label, COUNT(*)::int AS count FROM tickets GROUP BY status'),
        pool.query('SELECT category AS label, COUNT(*)::int AS count FROM tickets GROUP BY category ORDER BY count DESC'),
        pool.query('SELECT priority AS label, COUNT(*)::int AS count FROM tickets GROUP BY priority'),
        pool.query('SELECT COUNT(*)::int AS total, COUNT(tenant_id)::int AS occupied FROM properties'),
        pool.query(`SELECT COALESCE(SUM(monthly_rent), 0)::float8 AS expected FROM leases WHERE status = 'ACTIVE'`),
        pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600)::float8 AS hours FROM tickets WHERE status = 'RESOLVED'`),
        pool.query(
            `SELECT a.id, a.action, a.endpoint, a.ip_address, a.created_at, u.name AS user_name
             FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 15`)
    ]);

    const map = Object.fromEntries(monthly.rows.map(r => [r.period, r]));
    const months = [];
    for (let i = 0; i < 6; i++) {
        const p = shiftPeriod(since, i);
        months.push({ period: p, collected: map[p]?.collected || 0, pending: map[p]?.pending || 0 });
    }
    const thisMonth = map[period]?.collected || 0;

    res.json({
        period,
        months,
        tickets: { byStatus: byStatus.rows, byCategory: byCategory.rows, byPriority: byPriority.rows },
        occupancy: units.rows[0],
        rent: { expected: rent.rows[0].expected, collected: thisMonth },
        avgResolutionHours: res_time.rows[0].hours,
        auditLogs: logs.rows
    });
});

function csvCell(v) {
    let s = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, header, rows) {
    const lines = [header.join(','), ...rows.map(r => r.map(csvCell).join(','))];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send('\uFEFF' + lines.join('\r\n'));
}

app.get('/api/reports/payments.csv', auth, requireRole('LANDLORD'), async (req, res) => {
    const r = await pool.query(`${PAYMENT_SQL} ORDER BY p.created_at DESC`);
    sendCsv(res, 'homesync-payments.csv',
        ['Reference', 'Tenant', 'Unit', 'Period', 'Amount', 'Method', 'Tenant reference', 'Status', 'Submitted', 'Reviewed', 'Review note'],
        r.rows.map(p => [p.reference_id, p.tenant, p.unit, p.period, p.amount, p.method, p.external_ref, p.status, p.created_at, p.reviewed_at, p.review_note]));
});

app.get('/api/reports/tickets.csv', auth, requireRole('LANDLORD'), async (req, res) => {
    const rows = await listTickets(req.user);
    sendCsv(res, 'homesync-maintenance.csv',
        ['ID', 'Title', 'Category', 'Priority', 'Status', 'Tenant', 'Unit', 'Assigned to', 'Created', 'Updated', 'Resolution note'],
        rows.map(t => [t.id, t.title, t.category, t.priority, t.status, t.tenant, t.unit, t.staff, t.created_at, t.updated_at, t.resolution_note]));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html'), { dotfiles: 'allow' }));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html'), { dotfiles: 'allow' }));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js'), { dotfiles: 'allow' }));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css'), { dotfiles: 'allow' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
    if (req.file) removeStored(`${req.file.destination.split(path.sep).pop()}/${req.file.filename}`);

    if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message;
        return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'That record already exists.' });

    console.error(`${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HomeSync running on http://localhost:${PORT}`));

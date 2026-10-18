'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

dotenv.config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) dotenv.config({ path: path.join(__dirname, '_env') });
if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is missing. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    try {
        await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
        console.log('Schema is up to date.');

        const legacy = await pool.query(`SELECT id, password_hash FROM users WHERE password_hash !~ '^\\$2[aby]\\$'`);
        for (const u of legacy.rows) {
            await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(u.password_hash, 10), u.id]);
        }
        if (legacy.rows.length) console.log(`Hashed ${legacy.rows.length} plain-text password(s). Existing logins still work.`);

        if (process.argv.includes('--demo')) await seedDemo();
    } catch (err) {
        console.error('Setup failed:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();

async function seedDemo() {
    const accounts = [
        ['Alex Morgan', 'alex@homesync.test', 'Landlord123!', 'LANDLORD'],
        ['Jamie Davis', 'jamie@example.com', 'Tenant123!', 'TENANT'],
        ['Sam Reyes', 'sam@homesync.test', 'Staff1234!', 'MAINTENANCE']
    ];
    const ids = {};
    let tenantIsNew = false;
    for (const [name, email, pw, role] of accounts) {
        const ins = await pool.query(
            `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)
             ON CONFLICT (email) DO NOTHING RETURNING id`,
            [name, email, bcrypt.hashSync(pw, 10), role]
        );
        if (ins.rows[0]) {
            ids[role] = ins.rows[0].id;
            if (role === 'TENANT') tenantIsNew = true;
        } else {
            ids[role] = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
        }
    }
    if (!tenantIsNew) {
        console.log('Demo accounts already existed; skipped sample data.');
        return;
    }
    const unitIds = {};
    for (const unit of ['101', '102', '201', '202', '203', '204']) {
        const r = await pool.query(
            'INSERT INTO properties (unit_number, building, landlord_id) VALUES ($1,$2,$3) RETURNING id',
            [unit, 'Maple Residences', ids.LANDLORD]
        );
        unitIds[unit] = r.rows[0].id;
    }
    await pool.query('UPDATE properties SET tenant_id=$1 WHERE id=$2', [ids.TENANT, unitIds['204']]);
    await pool.query(
        `INSERT INTO leases (tenant_id, property_id, start_date, end_date, monthly_rent, status)
         VALUES ($1,$2,'2026-01-01','2026-12-31',12000,'ACTIVE')`,
        [ids.TENANT, unitIds['204']]
    );
    await pool.query(
        `INSERT INTO tickets (tenant_id, property_id, title, category, priority, description, status, assigned_staff_id) VALUES
         ($1,$2,'Leaking bathroom faucet','Plumbing','MEDIUM','Water is dripping from the bathroom faucet.','IN_PROGRESS',$3),
         ($1,$2,'Air conditioner inspection','Appliance','LOW','Please check the bedroom air conditioner.','RESOLVED',$3)`,
        [ids.TENANT, unitIds['204'], ids.MAINTENANCE]
    );
    console.log('\nDemo accounts (change these passwords!):');
    for (const [, email, pw, role] of accounts) console.log(`  ${role.padEnd(12)} ${email}  /  ${pw}`);
}


CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(30) CHECK (role IN ('TENANT', 'LANDLORD', 'MAINTENANCE')) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    unit_number VARCHAR(50) NOT NULL,
    building VARCHAR(50) NOT NULL,
    landlord_id INT REFERENCES users(id),
    tenant_id INT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS leases (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES users(id),
    property_id INT REFERENCES properties(id),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    monthly_rent NUMERIC(10, 2) NOT NULL,
    status VARCHAR(30) DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES users(id),
    property_id INT REFERENCES properties(id),
    title VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL,
    priority VARCHAR(20) CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')) NOT NULL,
    description TEXT NOT NULL,
    photo_url TEXT,
    status VARCHAR(30) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'RESOLVED')),
    assigned_staff_id INT REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES users(id),
    reference_id VARCHAR(50) UNIQUE NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    receipt_url TEXT NOT NULL,
    status VARCHAR(30) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    message TEXT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    endpoint VARCHAR(150) NOT NULL,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users    ADD COLUMN IF NOT EXISTS phone VARCHAR(30);

ALTER TABLE tickets  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE tickets  ADD COLUMN IF NOT EXISTS resolution_note TEXT;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS period VARCHAR(7);         
ALTER TABLE payments ADD COLUMN IF NOT EXISTS method VARCHAR(30);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS external_ref VARCHAR(80);   
ALTER TABLE payments ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
UPDATE payments SET period = to_char(created_at, 'YYYY-MM') WHERE period IS NULL;

CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES users(id),        
    uploaded_by INT REFERENCES users(id),
    title VARCHAR(150) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'OTHER',
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    size_bytes INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_tenant   ON tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tickets_staff    ON tickets(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant  ON payments(tenant_id, period);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notif_user       ON notifications(user_id, is_read);

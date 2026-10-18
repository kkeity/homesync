"use strict";

const MENUS = {
    tenant: [
        { id: "dashboard", label: "Dashboard", icon: "⌂" },
        { id: "maintenance", label: "Maintenance", icon: "🔧" },
        { id: "payments", label: "Payments", icon: "▤" },
        { id: "documents", label: "Documents", icon: "▧" },
        { id: "profile", label: "My Profile", icon: "○" }
    ],
    landlord: [
        { id: "dashboard", label: "Dashboard", icon: "⌂" },
        { id: "maintenance", label: "Maintenance Requests", icon: "🔧" },
        { id: "properties", label: "Properties & Units", icon: "▦" },
        { id: "tenants", label: "Tenants & Staff", icon: "♙" },
        { id: "payments", label: "Payments", icon: "▤" },
        { id: "documents", label: "Documents", icon: "▧" },
        { id: "reports", label: "Reports", icon: "▥" },
        { id: "profile", label: "My Profile", icon: "○" }
    ],
    maintenance: [
        { id: "dashboard", label: "Dashboard", icon: "⌂" },
        { id: "maintenance", label: "Assigned Requests", icon: "🔧" },
        { id: "profile", label: "My Profile", icon: "○" }
    ]
};

const ROLE_TEXT = {
    tenant: { chip: "Tenant App", label: "Tenant account" },
    landlord: { chip: "Landlord Portal", label: "Property manager" },
    maintenance: { chip: "Maintenance Portal", label: "Maintenance staff" }
};

const STATUS_LABEL = { PENDING: "Submitted", IN_PROGRESS: "In Progress", RESOLVED: "Completed" };
const STATUS_CLASS = { PENDING: "submitted", IN_PROGRESS: "in-progress", RESOLVED: "completed" };
const PRIORITY_LABEL = { LOW: "Low", MEDIUM: "Normal", HIGH: "High", URGENT: "Urgent" };
const PAY_LABEL = { PENDING: "Awaiting verification", VERIFIED: "Verified", REJECTED: "Rejected" };
const PAY_CLASS = { PENDING: "pending", VERIFIED: "verified", REJECTED: "rejected" };
const DOC_LABEL = { LEASE: "Lease", NOTICE: "Notice", RULES: "House rules", ID: "ID / Personal", OTHER: "Other" };
const METHODS = ["GCash", "Maya", "Bank Transfer", "Cash", "Other"];
const CATEGORIES = ["Plumbing", "Electrical", "Appliance", "Cleaning", "Other"];

const state = { user: null, page: "dashboard", filters: {}, token: 0, notifs: { items: [], unread: 0 }, pollTimer: null };
let C = {}; 
let toastTimer = null;

const $ = id => document.getElementById(id);
const pad4 = n => String(n).padStart(4, "0");

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

const peso = n => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtDate(v) {
    if (!v) return "—";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T00:00:00") : new Date(v);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(v) {
    const d = new Date(v);
    return isNaN(d) ? "—" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function monthLabel(period, short) {
    const [y, m] = period.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", short ? { month: "short" } : { month: "long", year: "numeric" });
}

const curPeriod = (offset = 0) => {
    const d = new Date();
    const x = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
};

function fileSize(bytes) {
    if (!bytes) return "";
    return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
}

const initials = name => String(name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const unitText = t => (t.unit ? `Unit ${t.unit}` : "No unit");
const role = () => state.user && state.user.role;

function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

async function api(url, { method = "GET", body } = {}) {
    const opts = { method, credentials: "same-origin", headers: {} };
    if (body instanceof FormData) {
        opts.body = body;
    } else if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const isJson = (res.headers.get("content-type") || "").includes("json");
    const data = isJson ? await res.json().catch(() => null) : null;
    if (res.status === 401 && !url.startsWith("/api/auth/login")) {
        if (state.user) showLogin("Your session ended. Please sign in again.");
        throw new Error("Please sign in again.");
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
}

function statusBadge(status) {
    return `<span class="status ${STATUS_CLASS[status] || ""}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function priorityBadge(priority) {
    return `<span class="status ${String(priority).toLowerCase() === "medium" ? "normal" : String(priority).toLowerCase()}">${esc(PRIORITY_LABEL[priority] || priority)}</span>`;
}

function payBadge(status) {
    return `<span class="status ${PAY_CLASS[status] || ""}">${esc(PAY_LABEL[status] || status)}</span>`;
}

function statCard(label, value, note, icon) {
    return `<div class="stat">
        <div class="stat-top"><span>${esc(label)}</span><span class="stat-icon">${esc(icon)}</span></div>
        <div class="stat-value">${esc(value)}</div>
        <div class="stat-note">${esc(note)}</div>
    </div>`;
}

function pageIntro(title, description, buttons = "") {
    return `<div class="page-intro"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="page-actions">${buttons}</div></div>`;
}

const empty = (title, text = "") => `<div class="empty-state"><strong>${esc(title)}</strong>${esc(text)}</div>`;

function rentStatusBadge(tenant) {
    if (!tenant.lease_id) return `<span class="status none">No lease</span>`;
    if (tenant.period_payment === "VERIFIED") return `<span class="status paid">Paid</span>`;
    if (tenant.period_payment === "PENDING") return `<span class="status pending">Awaiting verification</span>`;
    return new Date().getDate() > 5 ? `<span class="status overdue">Overdue</span>` : `<span class="status submitted">Due</span>`;
}

function rememberTickets(list) {
    C.tmap = C.tmap || {};
    list.forEach(t => { C.tmap[t.id] = t; });
}

function fieldHTML(f) {
    const id = "f_" + f.name;
    const req = f.required ? "required" : "";
    const val = f.value ?? "";
    let input;

    if (f.type === "select") {
        input = `<select id="${id}" name="${esc(f.name)}" ${req}>${f.options.map(o => {
            const v = typeof o === "object" ? o.value : o;
            const l = typeof o === "object" ? o.label : o;
            return `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`;
        }).join("")}</select>`;
    } else if (f.type === "textarea") {
        input = `<textarea id="${id}" name="${esc(f.name)}" rows="${f.rows || 4}" maxlength="${f.max || 3000}" placeholder="${esc(f.placeholder || "")}" ${req}>${esc(val)}</textarea>`;
    } else if (f.type === "file") {
        input = `<input id="${id}" name="${esc(f.name)}" type="file" accept="${esc(f.accept || "")}" ${req}>`;
    } else {
        input = `<input id="${id}" name="${esc(f.name)}" type="${f.type || "text"}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}" ${f.max ? `maxlength="${f.max}"` : ""} ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.step ? `step="${f.step}"` : ""} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ""} ${req}>`;
    }
    return `<label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>${input}${f.help ? `<div class="help">${esc(f.help)}</div>` : ""}`;
}

function openForm(cfg) {
    $("modalBox").innerHTML = `
        <div class="modal-head">
            <div><div class="eyebrow">${esc(cfg.eyebrow || "HOMESYNC")}</div><h2>${esc(cfg.title)}</h2></div>
            <button class="icon-btn" type="button" onclick="closeModal()" aria-label="Close">✕</button>
        </div>
        ${cfg.intro || ""}
        <form id="modalForm">
            ${(cfg.fields || []).map(fieldHTML).join("")}
            <div class="form-error" id="modalError" role="alert"></div>
            <div class="modal-actions">
                <button type="button" class="btn secondary" onclick="closeModal()">${cfg.submit ? "Cancel" : "Close"}</button>
                ${cfg.submit ? `<button type="submit" class="btn ${cfg.danger ? "danger" : "primary"}" id="modalSubmit">${esc(cfg.submit)}</button>` : ""}
            </div>
        </form>`;
    $("modal").classList.add("open");

    $("modalForm").addEventListener("submit", async event => {
        event.preventDefault();
        if (!cfg.submit) return closeModal();
        const btn = $("modalSubmit");
        $("modalError").textContent = "";
        btn.disabled = true;
        try {
            const fd = new FormData(event.target);
            let payload = fd;
            if (!cfg.multipart) {
                payload = {};
                for (const [k, v] of fd.entries()) payload[k] = v;
            }
            await cfg.onSubmit(payload);
            closeModal();
            if (cfg.success) toast(cfg.success);
        } catch (err) {
            $("modalError").textContent = err.message;
            btn.disabled = false;
        }
    });

    const first = $("modalForm").querySelector("input:not([type=file]), select, textarea");
    if (first) first.focus();
}

function closeModal() {
    $("modal").classList.remove("open");
    $("modalBox").innerHTML = "";
}

function showLogin(message = "") {
    state.user = null;
    C = {};
    clearInterval(state.pollTimer);
    closeModal();
    $("app").hidden = true;
    $("loginScreen").hidden = false;
    $("loginError").textContent = message;
    $("loginPassword").value = "";
}

async function startSession(user) {
    state.user = user;
    state.page = "dashboard";
    state.filters = {};
    C = {};
    $("loginScreen").hidden = true;
    $("app").hidden = false;
    paintUser();
    await Promise.all([render(), loadNotifications()]);
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(loadNotifications, 60000);
}

function paintUser() {
    const u = state.user;
    $("userName").textContent = u.name;
    $("userRole").textContent = ROLE_TEXT[u.role].label;
    $("roleChipText").textContent = ROLE_TEXT[u.role].chip;
    $("sideAvatar").textContent = initials(u.name);
    $("topAvatar").textContent = initials(u.name);
}

function initLogin() {
    $("loginForm").addEventListener("submit", async event => {
        event.preventDefault();
        const btn = $("loginSubmit");
        $("loginError").textContent = "";
        btn.disabled = true;
        try {
            const { user } = await api("/api/auth/login", {
                method: "POST",
                body: { email: $("loginEmail").value.trim(), password: $("loginPassword").value }
            });
            await startSession(user);
        } catch (err) {
            $("loginError").textContent = err.message;
        } finally {
            btn.disabled = false;
        }
    });
}

async function boot() {
    initLogin();
    document.addEventListener("keydown", e => { if (e.key === "Escape") { closeModal(); $("notifPanel").hidden = true; } });
    $("modal").addEventListener("mousedown", e => { if (e.target === $("modal")) closeModal(); });
    document.addEventListener("click", e => {
        if (!e.target.closest(".notif-wrap")) $("notifPanel").hidden = true;
    });
    try {
        const { user } = await api("/api/auth/me");
        await startSession(user);
    } catch {
        if (!state.user) showLogin();
    }
}

async function loadNotifications() {
    try {
        state.notifs = await api("/api/notifications");
        $("notifDot").hidden = state.notifs.unread === 0;
        if (!$("notifPanel").hidden) paintNotifs();
    } catch { /* ignore polling errors */ }
}

function paintNotifs() {
    const { items, unread } = state.notifs;
    $("notifPanel").innerHTML = `
        <div class="notif-head"><span>Notifications${unread ? ` (${unread})` : ""}</span>
            ${unread ? `<button onclick="A.readAll()">Mark all read</button>` : ""}</div>
        <div class="notif-list">${items.length ? items.map(n => `
            <button class="notif-item ${n.is_read ? "" : "unread"}" onclick="A.openNotif(${n.id}, '${esc(n.event_type)}')">
                ${esc(n.message)}<small>${esc(fmtDateTime(n.created_at))}</small>
            </button>`).join("") : empty("You're all caught up", "New activity will show up here.")}</div>`;
}

function titleFor(page) {
    const r = role();
    const first = state.user.name.split(" ")[0];
    const t = {
        dashboard: r === "tenant" ? `Welcome home, ${first}!` : r === "landlord" ? "Property overview" : "My work queue",
        maintenance: r === "tenant" ? "Maintenance requests" : r === "landlord" ? "Maintenance management" : "Assigned requests",
        payments: "Payments", documents: "Documents", profile: "My profile",
        properties: "Properties & units", tenants: "Tenants & staff", reports: "Reports & insights"
    };
    return t[page] || "HomeSync";
}

function paintChrome() {
    $("navigation").innerHTML = MENUS[role()].map(item => `
        <button type="button" class="nav-link ${state.page === item.id ? "active" : ""}" onclick="A.go('${item.id}')">
            <span class="nav-icon">${esc(item.icon)}</span><span class="nav-text">${esc(item.label)}</span>
        </button>`).join("");
    $("pageHeading").textContent = titleFor(state.page);
    $("sidebar").classList.remove("open");
}

async function render() {
    paintChrome();
    const token = ++state.token;
    const page = PAGES[state.page];
    $("content").innerHTML = `<div class="loading">Loading…</div>`;
    try {
        await page.load();
        if (token === state.token) $("content").innerHTML = page.draw();
    } catch (err) {
        if (token === state.token) $("content").innerHTML = `<section class="panel">${empty("Could not load this page", err.message)}</section>`;
    }
}

async function refresh() {
    const token = ++state.token;
    try {
        await PAGES[state.page].load();
        if (token === state.token) $("content").innerHTML = PAGES[state.page].draw();
    } catch (err) {
        toast(err.message);
    }
    loadNotifications();
}

function redraw() {
    $("content").innerHTML = PAGES[state.page].draw();
}

function ticketRows(items, showTenant) {
    if (!items.length) return empty("No maintenance requests", "New requests will appear here.");
    const manage = role() !== "tenant";
    return `<div class="request-list">${items.map(t => `
        <div class="request-row">
            <div class="request-symbol">🔧</div>
            <div class="request-info">
                <strong>${esc(t.title)}</strong>
                <small>#HS-${pad4(t.id)} · ${esc(fmtDate(t.created_at))} · ${esc(t.category)}${showTenant ? ` · ${esc(t.tenant)} · ${esc(unitText(t))}` : ""}${t.staff && role() !== "maintenance" ? ` · Assigned: ${esc(t.staff)}` : ""}</small>
            </div>
            <span class="badges">${priorityBadge(t.priority)}${statusBadge(t.status)}</span>
            <button class="btn secondary small" onclick="A.ticket(${t.id})">${manage ? "Manage" : "View"}</button>
        </div>`).join("")}</div>`;
}

function paymentActions(p) {
    const receipt = `<a class="btn secondary small" href="/api/payments/${p.id}/receipt" target="_blank" rel="noopener">Receipt</a>`;
    if (role() === "landlord" && p.status === "PENDING") {
        return `${receipt}<button class="btn good small" onclick="A.verify(${p.id})">Verify</button><button class="btn danger small" onclick="A.reject(${p.id})">Reject</button>`;
    }
    return receipt;
}

const PAGES = {
    dashboard: {
        async load() {
            C.overview = await api("/api/overview");
            const o = C.overview;
            rememberTickets(o.role === "tenant" ? o.tickets.recent : o.role === "landlord" ? o.recentTickets : o.recent);
        },
        draw() {
            const r = role();
            return r === "tenant" ? drawTenantDash() : r === "landlord" ? drawLandlordDash() : drawStaffDash();
        }
    },

    maintenance: {
        async load() {
            const jobs = [api("/api/tickets")];
            if (role() === "landlord" && !C.staff) jobs.push(api("/api/staff"));
            const [tickets, staff] = await Promise.all(jobs);
            C.tickets = tickets;
            if (staff) C.staff = staff;
            rememberTickets(tickets);
        },
        draw() {
            const r = role();
            const f = state.filters.maint || { status: "", priority: "", q: "" };
            const q = f.q.trim().toLowerCase();
            const items = C.tickets.filter(t =>
                (!f.status || t.status === f.status) &&
                (!f.priority || t.priority === f.priority) &&
                (!q || `${t.title} ${t.tenant} ${t.unit} ${t.category} ${t.description}`.toLowerCase().includes(q))
            );
            const intro = {
                tenant: ["My maintenance requests", "Submit and track maintenance issues."],
                landlord: ["Maintenance management", "Review requests, assign staff and update progress."],
                maintenance: ["Assigned requests", "Requests assigned to you. Update progress as you work."]
            }[r];
            return `
                ${pageIntro(intro[0], intro[1], r === "tenant" ? `<button class="btn primary" onclick="A.newRequest()">+ New request</button>` : "")}
                <section class="panel">
                    <div class="toolbar">
                        <select onchange="A.filter('maint','status',this.value)">
                            <option value="">All statuses</option>
                            ${Object.keys(STATUS_LABEL).map(s => `<option value="${s}" ${f.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}
                        </select>
                        <select onchange="A.filter('maint','priority',this.value)">
                            <option value="">All priorities</option>
                            ${Object.keys(PRIORITY_LABEL).map(s => `<option value="${s}" ${f.priority === s ? "selected" : ""}>${PRIORITY_LABEL[s]}</option>`).join("")}
                        </select>
                        <input type="search" placeholder="Search requests…" value="${esc(f.q)}" onchange="A.filter('maint','q',this.value)">
                    </div>
                    ${ticketRows(items, r !== "tenant")}
                </section>`;
        }
    },

    payments: {
        async load() {
            const jobs = [api("/api/payments")];
            if (role() === "tenant") jobs.push(api("/api/overview"));
            const [payments, overview] = await Promise.all(jobs);
            C.payments = payments;
            if (overview) C.overview = overview;
        },
        draw() {
            return role() === "tenant" ? drawTenantPayments() : drawLandlordPayments();
        }
    },

    documents: {
        async load() {
            const jobs = [api("/api/documents")];
            if (role() === "landlord") jobs.push(api("/api/tenants"));
            const [docs, tenants] = await Promise.all(jobs);
            C.docs = docs;
            if (tenants) C.tenants = tenants;
        },
        draw() {
            const f = state.filters.docs || { category: "" };
            const items = C.docs.filter(d => !f.category || d.category === f.category);
            const landlord = role() === "landlord";
            return `
                ${pageIntro("Documents",
                    landlord ? "Share leases, notices and house rules, and view files tenants uploaded." : "Your lease, notices and personal files in one place.",
                    `<button class="btn primary" onclick="A.uploadDoc()">${landlord ? "+ Upload & share" : "+ Upload document"}</button>`)}
                <section class="panel">
                    <div class="toolbar">
                        <select onchange="A.filter('docs','category',this.value)">
                            <option value="">All categories</option>
                            ${Object.keys(DOC_LABEL).map(c => `<option value="${c}" ${f.category === c ? "selected" : ""}>${DOC_LABEL[c]}</option>`).join("")}
                        </select>
                    </div>
                    ${items.length ? `<div class="table-wrap"><table>
                        <thead><tr><th>DOCUMENT</th><th>CATEGORY</th>${landlord ? "<th>SHARED WITH</th>" : ""}<th>UPLOADED BY</th><th>DATE</th><th></th></tr></thead>
                        <tbody>${items.map(d => {
                            const mine = d.uploaded_by === state.user.id;
                            return `<tr>
                                <td><strong>${esc(d.title)}</strong><br><small>${esc(d.file_name)} ${esc(fileSize(d.size_bytes))}</small></td>
                                <td>${esc(DOC_LABEL[d.category] || d.category)}</td>
                                ${landlord ? `<td>${d.tenant_id ? esc(d.tenant) : "All tenants"}</td>` : ""}
                                <td>${esc(d.uploader || "—")}</td>
                                <td>${esc(fmtDate(d.created_at))}</td>
                                <td class="row-actions">
                                    <a class="btn secondary small" href="/api/documents/${d.id}/download?inline=1" target="_blank" rel="noopener">View</a>
                                    <a class="btn secondary small" href="/api/documents/${d.id}/download">Download</a>
                                    ${landlord || mine ? `<button class="btn danger small" onclick="A.deleteDoc(${d.id})">Delete</button>` : ""}
                                </td></tr>`;
                        }).join("")}</tbody></table></div>` : empty("No documents yet", landlord ? "Upload a lease or notice to share it." : "Documents shared with you will appear here.")}
                </section>`;
        }
    },

    profile: {
        async load() {
            C.overview = role() === "tenant" ? await api("/api/overview") : null;
        },
        draw() {
            const u = state.user;
            const lease = C.overview && C.overview.lease;
            return `
                ${pageIntro("My profile", "Your account details and security.",
                    `<button class="btn secondary" onclick="A.editProfile()">Edit profile</button><button class="btn primary" onclick="A.changePassword()">Change password</button>`)}
                <section class="panel">
                    <dl class="info-grid">
                        <div><dt>FULL NAME</dt><dd>${esc(u.name)}</dd></div>
                        <div><dt>EMAIL</dt><dd>${esc(u.email)}</dd></div>
                        <div><dt>PHONE</dt><dd>${esc(u.phone || "Not set")}</dd></div>
                        <div><dt>ACCOUNT TYPE</dt><dd>${esc(ROLE_TEXT[u.role].label)}</dd></div>
                    </dl>
                </section>
                ${role() === "tenant" ? `<section class="panel">
                    <div class="panel-head"><div><h3>Lease details</h3><p>Set by your property manager.</p></div></div>
                    ${lease && lease.lease_id ? `<dl class="info-grid">
                        <div><dt>UNIT</dt><dd>${esc(lease.unit_number)} · ${esc(lease.building)}</dd></div>
                        <div><dt>MONTHLY RENT</dt><dd>${esc(peso(lease.monthly_rent))}</dd></div>
                        <div><dt>LEASE START</dt><dd>${esc(fmtDate(lease.start_date))}</dd></div>
                        <div><dt>LEASE END</dt><dd>${esc(fmtDate(lease.end_date))}</dd></div>
                    </dl>` : empty("No active lease", "Contact your property manager to be assigned a unit.")}
                </section>` : ""}`;
        }
    },

    properties: {
        async load() {
            C.properties = await api("/api/properties");
        },
        draw() {
            const props = C.properties;
            const occupied = props.filter(p => p.tenant_id).length;
            return `
                ${pageIntro("Properties & units", `${props.length} units · ${occupied} occupied · ${props.length - occupied} vacant`,
                    `<button class="btn primary" onclick="A.addUnit()">+ Add unit</button>`)}
                <section class="panel">
                    ${props.length ? `<div class="table-wrap"><table>
                        <thead><tr><th>BUILDING</th><th>UNIT</th><th>STATUS</th><th>TENANT</th><th>RENT</th><th>LEASE ENDS</th><th>OPEN REQUESTS</th><th></th></tr></thead>
                        <tbody>${props.map(p => `<tr>
                            <td>${esc(p.building)}</td>
                            <td><strong>${esc(p.unit_number)}</strong></td>
                            <td>${p.tenant_id ? `<span class="status verified">Occupied</span>` : `<span class="status none">Vacant</span>`}</td>
                            <td>${esc(p.tenant || "—")}</td>
                            <td>${p.monthly_rent ? esc(peso(p.monthly_rent)) : "—"}</td>
                            <td>${esc(fmtDate(p.end_date))}</td>
                            <td>${p.open_tickets}</td>
                            <td class="row-actions">
                                <button class="btn secondary small" onclick="A.editUnit(${p.id})">Edit</button>
                                <button class="btn danger small" onclick="A.deleteUnit(${p.id})">Delete</button>
                            </td></tr>`).join("")}</tbody></table></div>` : empty("No units yet", "Add your first unit to get started.")}
                </section>`;
        }
    },

    tenants: {
        async load() {
            const [tenants, staff, properties] = await Promise.all([api("/api/tenants"), api("/api/staff"), api("/api/properties")]);
            C.tenants = tenants;
            C.staff = staff;
            C.properties = properties;
        },
        draw() {
            return `
                ${pageIntro("Tenants & staff", "Manage tenant accounts, leases and your maintenance team.",
                    `<button class="btn secondary" onclick="A.addStaff()">+ Add staff</button><button class="btn primary" onclick="A.addTenant()">+ Add tenant</button>`)}
                <section class="panel">
                    <div class="panel-head"><div><h3>Tenants</h3><p>${C.tenants.length} registered</p></div></div>
                    ${C.tenants.length ? `<div class="table-wrap"><table>
                        <thead><tr><th>TENANT</th><th>UNIT</th><th>RENT</th><th>LEASE</th><th>${esc(monthLabel(curPeriod()).toUpperCase())}</th><th></th></tr></thead>
                        <tbody>${C.tenants.map(t => `<tr>
                            <td><strong>${esc(t.name)}</strong><br><small>${esc(t.email)}${t.phone ? " · " + esc(t.phone) : ""}</small></td>
                            <td>${t.unit_number ? esc(t.unit_number) + "<br><small>" + esc(t.building) + "</small>" : "—"}</td>
                            <td>${t.monthly_rent ? esc(peso(t.monthly_rent)) : "—"}</td>
                            <td>${t.lease_id ? esc(fmtDate(t.start_date)) + " – " + esc(fmtDate(t.end_date)) : "—"}</td>
                            <td>${rentStatusBadge(t)}</td>
                            <td class="row-actions">
                                <button class="btn secondary small" onclick="A.editTenant(${t.id})">Edit</button>
                                ${t.lease_id
                                    ? `<button class="btn secondary small" onclick="A.editLease(${t.id})">Lease</button><button class="btn danger small" onclick="A.endLease(${t.id})">End lease</button>`
                                    : `<button class="btn good small" onclick="A.assignUnit(${t.id})">Assign unit</button>`}
                            </td></tr>`).join("")}</tbody></table></div>` : empty("No tenants yet", "Add a tenant to create their account and lease.")}
                </section>
                <section class="panel">
                    <div class="panel-head"><div><h3>Maintenance staff</h3><p>${C.staff.length} on your team</p></div></div>
                    ${C.staff.length ? `<div class="table-wrap"><table>
                        <thead><tr><th>NAME</th><th>EMAIL</th><th>PHONE</th><th>OPEN JOBS</th></tr></thead>
                        <tbody>${C.staff.map(s => `<tr><td><strong>${esc(s.name)}</strong></td><td>${esc(s.email)}</td><td>${esc(s.phone || "—")}</td><td>${s.open_tickets}</td></tr>`).join("")}</tbody></table></div>`
                        : empty("No staff yet", "Add a staff member so you can assign maintenance requests.")}
                </section>`;
        }
    },

    reports: {
        async load() {
            C.report = await api("/api/reports");
        },
        draw() {
            const r = C.report;
            const max = Math.max(1, ...r.months.map(m => m.collected + m.pending));
            const occ = r.occupancy.total ? Math.round((r.occupancy.occupied / r.occupancy.total) * 100) : 0;
            const rate = r.rent.expected ? Math.round((r.rent.collected / r.rent.expected) * 100) : 0;
            const hours = r.avgResolutionHours;
            const hbars = (rows, labels) => {
                const m = Math.max(1, ...rows.map(x => x.count));
                return rows.length ? rows.map(x => `<div class="hbar-row"><span>${esc(labels ? labels[x.label] || x.label : x.label)}</span>
                    <div class="hbar-track"><div class="hbar-fill" style="width:${(x.count / m) * 100}%"></div></div><strong>${x.count}</strong></div>`).join("")
                    : `<p class="muted">No data yet.</p>`;
            };
            return `
                ${pageIntro("Reports & insights", "Rent collection, maintenance activity and system history.",
                    `<a class="btn secondary" href="/api/reports/payments.csv">Export payments (CSV)</a><a class="btn secondary" href="/api/reports/tickets.csv">Export requests (CSV)</a>`)}
                <div class="stats">
                    ${statCard("Collected this month", peso(r.rent.collected), `of ${peso(r.rent.expected)} expected (${rate}%)`, "₱")}
                    ${statCard("Occupancy", occ + "%", `${r.occupancy.occupied} of ${r.occupancy.total} units`, "▦")}
                    ${statCard("Avg. resolution time", hours == null ? "—" : hours < 48 ? hours.toFixed(1) + " hrs" : (hours / 24).toFixed(1) + " days", "Completed requests", "✓")}
                    ${statCard("Total requests", r.tickets.byStatus.reduce((a, x) => a + x.count, 0), "All time", "🔧")}
                </div>
                <section class="panel">
                    <div class="panel-head"><div><h3>Rent collected</h3><p>Last 6 months</p></div></div>
                    <div class="bars">${r.months.map(m => `
                        <div class="bar-col">
                            <div class="bar-val">${m.collected || m.pending ? "₱" + Math.round((m.collected + m.pending) / 1000) + "k" : ""}</div>
                            <div class="bar-stack">
                                <div class="bar pending" style="height:${(m.pending / max) * 100}%"></div>
                                <div class="bar" style="height:${(m.collected / max) * 100}%"></div>
                            </div>
                            <div class="bar-label">${esc(monthLabel(m.period, true))}</div>
                        </div>`).join("")}</div>
                    <div class="legend"><span><i></i>Verified</span><span><i class="p"></i>Awaiting verification</span></div>
                </section>
                <div class="two-col" style="margin-top:20px">
                    <section class="panel"><div class="panel-head"><div><h3>Requests by status</h3></div></div>${hbars(r.tickets.byStatus, STATUS_LABEL)}</section>
                    <section class="panel"><div class="panel-head"><div><h3>Requests by category</h3></div></div>${hbars(r.tickets.byCategory)}</section>
                </div>
                <section class="panel">
                    <div class="panel-head"><div><h3>Recent activity</h3><p>Latest account and system actions</p></div></div>
                    ${r.auditLogs.length ? `<div class="table-wrap"><table>
                        <thead><tr><th>WHEN</th><th>USER</th><th>ACTION</th><th>IP</th></tr></thead>
                        <tbody>${r.auditLogs.map(a => `<tr><td>${esc(fmtDateTime(a.created_at))}</td><td>${esc(a.user_name || "—")}</td><td>${esc(a.action.replace(/_/g, " ").toLowerCase())}</td><td>${esc(a.ip_address || "—")}</td></tr>`).join("")}</tbody></table></div>` : empty("No activity yet")}
                </section>`;
        }
    }
};

function drawTenantDash() {
    const o = C.overview;
    const l = o.lease;
    const rentState = o.periodPayment
        ? (o.periodPayment.status === "VERIFIED" ? ["Paid", "paid"] : ["Awaiting verification", "pending"])
        : (o.overdue ? ["Overdue", "overdue"] : ["Due", "submitted"]);
    return `
        <section class="welcome">
            <div><h1>Your home, all in one place.</h1>
            <p>${l ? `Unit ${esc(l.unit_number)} · ${esc(l.building)}.` : "You are not assigned to a unit yet."} Manage requests, pay rent and keep your documents handy.</p></div>
            <button class="btn primary" style="background:white;color:var(--sage)" onclick="A.newRequest()">+ New request</button>
        </section>
        <div class="stats">
            ${statCard("Active requests", o.tickets.open, "Awaiting completion", "⚒")}
            ${statCard("Completed requests", o.tickets.resolved, "Resolved", "✓")}
            ${statCard("Monthly rent", l && l.monthly_rent ? peso(l.monthly_rent) : "—", `Next due: ${fmtDate(o.nextDue)}`, "₱")}
            ${statCard("My unit", l ? l.unit_number : "—", l ? l.building : "Not assigned", "⌂")}
        </div>
        <div class="dashboard-grid">
            <section class="panel">
                <div class="panel-head"><div><h3>Recent maintenance</h3><p>Track your active ticket progress.</p></div>
                    <button class="btn secondary small" onclick="A.go('maintenance')">View all</button></div>
                ${ticketRows(o.tickets.recent, false)}
            </section>
            <section class="panel">
                <div class="panel-head"><div><h3>${esc(monthLabel(o.period))} rent</h3><p>${l && l.monthly_rent ? esc(peso(l.monthly_rent)) : "No active lease"}</p></div>
                    <span class="status ${rentState[1]}">${rentState[0]}</span></div>
                ${!o.periodPayment && l && l.monthly_rent
                    ? `<p class="muted" style="font-size:12px">Pay using GCash, Maya or bank transfer, then upload your receipt for verification.</p>
                       <button class="btn primary" onclick="A.payRent()">Upload receipt</button>`
                    : o.periodPayment ? `<p class="muted" style="font-size:12px">Thank you! You can see all your payments on the Payments page.</p>
                       <button class="btn secondary" onclick="A.go('payments')">View payments</button>` : ""}
            </section>
        </div>`;
}

function drawLandlordDash() {
    const o = C.overview;
    const p = o.payments;
    return `
        <section class="welcome">
            <div><h1>Good day, ${esc(state.user.name.split(" ")[0])}.</h1>
            <p>${o.tickets.urgent ? `${o.tickets.urgent} urgent request${o.tickets.urgent > 1 ? "s need" : " needs"} attention. ` : ""}${p.pending ? `${p.pending} payment${p.pending > 1 ? "s are" : " is"} waiting for verification.` : "Everything is up to date."}</p></div>
            <button class="btn primary" style="background:white;color:var(--sage)" onclick="A.go('maintenance')">Manage requests →</button>
        </section>
        <div class="stats">
            ${statCard("Total units", o.units.total, `${o.units.occupied} occupied`, "⌂")}
            ${statCard("Active tenants", o.tenants, "Registered", "♙")}
            ${statCard("Open requests", o.tickets.open, `${o.tickets.urgent} urgent`, "⚒")}
            ${statCard("Resolved requests", o.tickets.resolved, "Completed", "✓")}
        </div>
        <div class="stats">
            ${statCard("Collected this month", peso(p.collected), `of ${peso(p.expected)} expected`, "₱")}
            ${statCard("Awaiting verification", p.pending, "Payments to review", "▤")}
            ${statCard("Unpaid tenants", p.unpaid, monthLabel(o.period), "!")}
            ${statCard("Vacant units", o.units.total - o.units.occupied, "Available", "▦")}
        </div>
        <div class="dashboard-grid">
            <section class="panel">
                <div class="panel-head"><div><h3>Maintenance overview</h3><p>Review and update tenant requests.</p></div>
                    <button class="btn secondary small" onclick="A.go('maintenance')">View all</button></div>
                ${ticketRows(o.recentTickets, true)}
            </section>
            <section class="panel">
                <div class="panel-head"><div><h3>Payments to verify</h3><p>Latest receipts</p></div>
                    <button class="btn secondary small" onclick="A.go('payments')">View all</button></div>
                ${o.pendingPayments.length ? o.pendingPayments.map(x => `
                    <div class="request-row" style="flex-wrap:wrap">
                        <div class="request-info"><strong>${esc(x.tenant)} · ${esc(peso(x.amount))}</strong>
                            <small>${esc(monthLabel(x.period))} · ${esc(x.method || "")}</small></div>
                        <span class="badges">${paymentActions(x)}</span>
                    </div>`).join("") : empty("Nothing to verify", "New receipts will show up here.")}
            </section>
        </div>`;
}

function drawStaffDash() {
    const o = C.overview;
    return `
        <section class="welcome">
            <div><h1>Hi ${esc(state.user.name.split(" ")[0])}, here is your queue.</h1>
            <p>Update each request as you work so the tenant and landlord stay informed.</p></div>
            <button class="btn primary" style="background:white;color:var(--sage)" onclick="A.go('maintenance')">Open requests →</button>
        </section>
        <div class="stats">
            ${statCard("New", o.assigned, "Not started", "!")}
            ${statCard("In progress", o.inProgress, "Being handled", "⚒")}
            ${statCard("Completed", o.resolved, "Done", "✓")}
            ${statCard("Total assigned", o.assigned + o.inProgress + o.resolved, "All time", "🔧")}
        </div>
        <section class="panel">
            <div class="panel-head"><div><h3>Open requests</h3><p>Assigned to you</p></div></div>
            ${ticketRows(o.recent, true)}
        </section>`;
}

function drawTenantPayments() {
    const o = C.overview;
    const l = o.lease;
    const canPay = l && l.monthly_rent && !o.periodPayment;
    return `
        ${pageIntro("Payments", "Pay your rent and track every receipt.")}
        <div class="rent-card">
            <div>
                <div class="label">MONTHLY RENT</div>
                <div class="amount">${l && l.monthly_rent ? esc(peso(l.monthly_rent)) : "—"}</div>
                <div class="sub">${!l || !l.monthly_rent ? "No active lease" : o.periodPayment
                    ? `${esc(monthLabel(o.period))}: ${o.periodPayment.status === "VERIFIED" ? "paid" : "awaiting verification"} · next due ${esc(fmtDate(o.nextDue))}`
                    : `${esc(monthLabel(o.period))} is ${o.overdue ? "overdue" : "due"} · pay by GCash, Maya or bank transfer`}</div>
            </div>
            ${l && l.monthly_rent ? `<button class="btn" onclick="A.payRent()">${canPay ? "Upload receipt" : "Pay another month"}</button>` : ""}
        </div>
        <section class="panel">
            ${C.payments.length ? `<div class="table-wrap"><table>
                <thead><tr><th>PERIOD</th><th>REFERENCE</th><th>AMOUNT</th><th>METHOD</th><th>SUBMITTED</th><th>STATUS</th><th></th></tr></thead>
                <tbody>${C.payments.map(p => `<tr>
                    <td><strong>${esc(monthLabel(p.period))}</strong></td>
                    <td>${esc(p.reference_id)}${p.external_ref ? `<br><small>Your ref: ${esc(p.external_ref)}</small>` : ""}</td>
                    <td>${esc(peso(p.amount))}</td>
                    <td>${esc(p.method || "—")}</td>
                    <td>${esc(fmtDate(p.created_at))}</td>
                    <td>${payBadge(p.status)}${p.review_note ? `<br><small>${esc(p.review_note)}</small>` : ""}</td>
                    <td class="row-actions">${paymentActions(p)}</td></tr>`).join("")}</tbody></table></div>` : empty("No payments yet", "Upload your first receipt to get started.")}
        </section>`;
}

function drawLandlordPayments() {
    const f = state.filters.pay || { status: "", q: "" };
    const q = f.q.trim().toLowerCase();
    const cur = curPeriod();
    const items = C.payments.filter(p =>
        (!f.status || p.status === f.status) &&
        (!q || `${p.tenant} ${p.unit} ${p.reference_id} ${p.external_ref || ""}`.toLowerCase().includes(q)));
    const pending = C.payments.filter(p => p.status === "PENDING").length;
    const collected = C.payments.filter(p => p.status === "VERIFIED" && p.period === cur).reduce((a, p) => a + p.amount, 0);
    const total = C.payments.filter(p => p.status === "VERIFIED").reduce((a, p) => a + p.amount, 0);
    return `
        ${pageIntro("Payments", "Verify tenant receipts and keep the ledger accurate.",
            `<a class="btn secondary" href="/api/reports/payments.csv">Export CSV</a>`)}
        <div class="stats">
            ${statCard("Awaiting verification", pending, "Receipts to review", "▤")}
            ${statCard("Collected this month", peso(collected), monthLabel(cur), "₱")}
            ${statCard("Total verified", peso(total), "All time", "✓")}
            ${statCard("Records", C.payments.length, "All payments", "▥")}
        </div>
        <section class="panel">
            <div class="toolbar">
                <select onchange="A.filter('pay','status',this.value)">
                    <option value="">All statuses</option>
                    ${Object.keys(PAY_LABEL).map(s => `<option value="${s}" ${f.status === s ? "selected" : ""}>${PAY_LABEL[s]}</option>`).join("")}
                </select>
                <input type="search" placeholder="Search tenant, unit or reference…" value="${esc(f.q)}" onchange="A.filter('pay','q',this.value)">
            </div>
            ${items.length ? `<div class="table-wrap"><table>
                <thead><tr><th>TENANT</th><th>PERIOD</th><th>AMOUNT</th><th>METHOD / REF</th><th>SUBMITTED</th><th>STATUS</th><th></th></tr></thead>
                <tbody>${items.map(p => `<tr>
                    <td><strong>${esc(p.tenant)}</strong><br><small>${p.unit ? "Unit " + esc(p.unit) : ""}</small></td>
                    <td>${esc(monthLabel(p.period))}</td>
                    <td>${esc(peso(p.amount))}</td>
                    <td>${esc(p.method || "—")}<br><small>${esc(p.external_ref || p.reference_id)}</small></td>
                    <td>${esc(fmtDate(p.created_at))}</td>
                    <td>${payBadge(p.status)}${p.review_note ? `<br><small>${esc(p.review_note)}</small>` : ""}</td>
                    <td class="row-actions">${paymentActions(p)}</td></tr>`).join("")}</tbody></table></div>` : empty("No payments found", "Tenant receipts will appear here.")}
        </section>`;
}

const unique = (list) => [...new Set(list)];

async function ensureStaff() {
    if (!C.staff) C.staff = await api("/api/staff");
    return C.staff;
}

const A = {
    go(page) {
        state.page = page;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
    },

    toggleMenu() { $("sidebar").classList.toggle("open"); },

    filter(group, key, value) {
        state.filters[group] = { ...(state.filters[group] || { status: "", priority: "", q: "", category: "" }), [key]: value };
        redraw();
    },

    async logout() {
        try { await api("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
        showLogin();
    },

    toggleNotifs() {
        const panel = $("notifPanel");
        panel.hidden = !panel.hidden;
        if (!panel.hidden) { paintNotifs(); loadNotifications(); }
    },
    async readAll() {
        await api("/api/notifications/read-all", { method: "POST" });
        await loadNotifications();
    },
    async openNotif(id, type) {
        $("notifPanel").hidden = true;
        try { await api(`/api/notifications/${id}/read`, { method: "POST" }); } catch { /* ignore */ }
        const target = type.startsWith("TICKET") ? "maintenance" : type.startsWith("PAYMENT") ? "payments" : type === "DOCUMENT" ? "documents" : "dashboard";
        const allowed = MENUS[role()].some(m => m.id === target);
        A.go(allowed ? target : "dashboard");
        loadNotifications();
    },

    newRequest() {
        openForm({
            eyebrow: "HOMESYNC SERVICE",
            title: "New maintenance request",
            multipart: true,
            submit: "Submit request",
            success: "Maintenance request submitted!",
            fields: [
                { name: "title", label: "Request title", required: true, max: 150, placeholder: "e.g. Leaking kitchen faucet" },
                { name: "category", label: "Category", type: "select", required: true, options: [{ value: "", label: "Select a category" }, ...CATEGORIES] },
                { name: "priority", label: "Priority", type: "select", value: "MEDIUM", options: [{ value: "LOW", label: "Low" }, { value: "MEDIUM", label: "Normal" }, { value: "HIGH", label: "High" }, { value: "URGENT", label: "Urgent" }] },
                { name: "description", label: "Description", type: "textarea", required: true, placeholder: "Describe the issue…" },
                { name: "photo", label: "Photo (optional)", type: "file", accept: ".jpg,.jpeg,.png,.webp", help: "JPG, PNG or WEBP up to 5 MB." }
            ],
            onSubmit: async fd => {
                await api("/api/tickets", { method: "POST", body: fd });
                state.page = "maintenance";
                await render();
                loadNotifications();
            }
        });
    },

    async ticket(id) {
        const t = C.tmap && C.tmap[id];
        if (!t) return;
        const r = role();
        const intro = `<div class="detail-box">
            <div class="meta">#HS-${pad4(t.id)} · ${esc(fmtDate(t.created_at))} · ${esc(t.category)} · ${esc(t.tenant)} · ${esc(unitText(t))}</div>
            <p style="margin:8px 0 0;white-space:pre-wrap">${esc(t.description)}</p>
            ${t.has_photo ? `<a href="/api/tickets/${t.id}/photo" target="_blank" rel="noopener"><img src="/api/tickets/${t.id}/photo" alt="Attached photo"></a>` : ""}
            ${r === "tenant" ? `<p style="margin:10px 0 0"><span class="badges">${priorityBadge(t.priority)}${statusBadge(t.status)}</span></p>
                ${t.staff ? `<p class="meta" style="margin:8px 0 0">Assigned to ${esc(t.staff)}</p>` : ""}
                ${t.resolution_note ? `<p style="margin:8px 0 0"><strong>Update:</strong> ${esc(t.resolution_note)}</p>` : ""}` : ""}
        </div>`;

        if (r === "tenant") return openForm({ title: t.title, eyebrow: "MAINTENANCE REQUEST", intro });

        const fields = [
            { name: "status", label: "Status", type: "select", value: t.status, options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) }
        ];
        if (r === "landlord") {
            let staff = [];
            try { staff = await ensureStaff(); } catch { /* keep empty */ }
            fields.push(
                { name: "priority", label: "Priority", type: "select", value: t.priority, options: Object.entries(PRIORITY_LABEL).map(([value, label]) => ({ value, label })) },
                { name: "assigned_staff_id", label: "Assigned to", type: "select", value: t.assigned_staff_id ?? "",
                  options: [{ value: "", label: "Unassigned" }, ...staff.map(s => ({ value: s.id, label: `${s.name} (${s.open_tickets} open)` }))],
                  help: staff.length ? "" : "Add maintenance staff on the Tenants & Staff page to assign requests." }
            );
        }
        fields.push({ name: "resolution_note", label: "Note for the tenant", type: "textarea", rows: 3, max: 2000, value: t.resolution_note || "", placeholder: "e.g. Plumber scheduled for Friday morning." });

        openForm({
            title: t.title, eyebrow: "MANAGE REQUEST", intro, fields, submit: "Save changes", success: "Request updated.",
            onSubmit: async body => {
                const updated = await api(`/api/tickets/${id}`, { method: "PATCH", body });
                rememberTickets([updated]);
                await refresh();
            }
        });
    },

    payRent() {
        const l = C.overview && C.overview.lease;
        if (!l || !l.monthly_rent) return toast("You have no active lease.");
        const taken = new Set((C.payments || []).filter(p => p.status !== "REJECTED").map(p => p.period));
        const choices = [curPeriod(-1), curPeriod(0), curPeriod(1)];
        const defaultPeriod = choices.slice(1).find(p => !taken.has(p)) || choices[1];
        openForm({
            eyebrow: "RENT PAYMENT",
            title: "Upload payment receipt",
            multipart: true,
            submit: "Submit receipt",
            success: "Receipt uploaded! Awaiting verification.",
            intro: `<div class="detail-box">Amount due: <strong>${esc(peso(l.monthly_rent))}</strong> · Unit ${esc(l.unit_number)}<br>
                <span class="meta">Pay your landlord first (GCash, Maya, bank transfer or cash), then upload the receipt or screenshot here.</span></div>`,
            fields: [
                { name: "period", label: "Rent for", type: "select", value: defaultPeriod, options: choices.map(p => ({ value: p, label: monthLabel(p) + (taken.has(p) ? " (already submitted)" : "") })) },
                { name: "method", label: "Payment method", type: "select", required: true, options: METHODS },
                { name: "external_ref", label: "Transaction / reference number", max: 80, placeholder: "Optional", help: "The reference number shown on your GCash, Maya or bank receipt." },
                { name: "receipt", label: "Receipt (photo, screenshot or PDF)", type: "file", required: true, accept: ".jpg,.jpeg,.png,.webp,.pdf", help: "JPG, PNG, WEBP or PDF up to 5 MB." }
            ],
            onSubmit: async fd => {
                await api("/api/payments", { method: "POST", body: fd });
                await refresh();
            }
        });
    },

    async verify(id) {
        try {
            await api(`/api/payments/${id}`, { method: "PATCH", body: { status: "VERIFIED" } });
            toast("Payment verified.");
            await refresh();
        } catch (err) { toast(err.message); }
    },

    reject(id) {
        openForm({
            title: "Reject payment", eyebrow: "PAYMENT REVIEW", submit: "Reject payment", danger: true, success: "Payment rejected. The tenant was notified.",
            fields: [{ name: "note", label: "Reason (shown to the tenant)", type: "textarea", rows: 3, max: 500, required: true, placeholder: "e.g. The amount on the receipt does not match." }],
            onSubmit: async body => {
                await api(`/api/payments/${id}`, { method: "PATCH", body: { status: "REJECTED", note: body.note } });
                await refresh();
            }
        });
    },

    uploadDoc() {
        const landlord = role() === "landlord";
        const fields = [
            { name: "title", label: "Title", max: 150, placeholder: "e.g. Rental Agreement 2026" },
            { name: "category", label: "Category", type: "select", value: landlord ? "LEASE" : "ID", options: Object.entries(DOC_LABEL).map(([value, label]) => ({ value, label })) }
        ];
        if (landlord) {
            fields.push({
                name: "tenant_id", label: "Share with", type: "select", value: "all",
                options: [{ value: "all", label: "All tenants" }, ...(C.tenants || []).map(t => ({ value: t.id, label: `${t.name}${t.unit_number ? " (Unit " + t.unit_number + ")" : ""}` }))]
            });
        }
        fields.push({ name: "file", label: "File", type: "file", required: true, accept: ".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx", help: "PDF, image, DOC or DOCX up to 10 MB." });
        openForm({
            title: landlord ? "Upload & share document" : "Upload document", eyebrow: "DOCUMENTS", multipart: true, fields,
            submit: "Upload", success: "Document uploaded.",
            onSubmit: async fd => { await api("/api/documents", { method: "POST", body: fd }); await refresh(); }
        });
    },

    async deleteDoc(id) {
        if (!confirm("Delete this document? This cannot be undone.")) return;
        try {
            await api(`/api/documents/${id}`, { method: "DELETE" });
            toast("Document deleted.");
            await refresh();
        } catch (err) { toast(err.message); }
    },

    editProfile() {
        const u = state.user;
        openForm({
            title: "Edit profile", eyebrow: "MY PROFILE", submit: "Save", success: "Profile updated.",
            fields: [
                { name: "name", label: "Full name", required: true, max: 100, value: u.name },
                { name: "email", label: "Email", type: "email", required: true, max: 100, value: u.email },
                { name: "phone", label: "Phone", max: 30, value: u.phone }
            ],
            onSubmit: async body => {
                const { user } = await api("/api/auth/profile", { method: "PATCH", body });
                state.user = user;
                paintUser();
                paintChrome();
                await refresh();
            }
        });
    },

    changePassword() {
        openForm({
            title: "Change password", eyebrow: "SECURITY", submit: "Update password", success: "Password changed.",
            fields: [
                { name: "current", label: "Current password", type: "password", required: true, autocomplete: "current-password" },
                { name: "next", label: "New password", type: "password", required: true, autocomplete: "new-password", help: "At least 8 characters." },
                { name: "confirm", label: "Confirm new password", type: "password", required: true, autocomplete: "new-password" }
            ],
            onSubmit: async body => {
                if (body.next !== body.confirm) throw new Error("The new passwords do not match.");
                await api("/api/auth/password", { method: "POST", body: { current: body.current, next: body.next } });
            }
        });
    },

    addUnit() {
        const buildings = unique((C.properties || []).map(p => p.building));
        openForm({
            title: "Add unit", eyebrow: "PROPERTIES", submit: "Add unit", success: "Unit added.",
            fields: [
                { name: "building", label: "Building", required: true, max: 50, value: buildings[0] || "", placeholder: "e.g. Maple Residences" },
                { name: "unit_number", label: "Unit number", required: true, max: 50, placeholder: "e.g. 301" }
            ],
            onSubmit: async body => { await api("/api/properties", { method: "POST", body }); await refresh(); }
        });
    },

    editUnit(id) {
        const p = C.properties.find(x => x.id === id);
        if (!p) return;
        openForm({
            title: "Edit unit", eyebrow: "PROPERTIES", submit: "Save", success: "Unit updated.",
            fields: [
                { name: "building", label: "Building", required: true, max: 50, value: p.building },
                { name: "unit_number", label: "Unit number", required: true, max: 50, value: p.unit_number }
            ],
            onSubmit: async body => { await api(`/api/properties/${id}`, { method: "PATCH", body }); await refresh(); }
        });
    },

    async deleteUnit(id) {
        if (!confirm("Delete this unit?")) return;
        try {
            await api(`/api/properties/${id}`, { method: "DELETE" });
            toast("Unit deleted.");
            await refresh();
        } catch (err) { toast(err.message); }
    },

    addTenant() {
        const vacant = (C.properties || []).filter(p => !p.tenant_id);
        const year = new Date().getFullYear();
        openForm({
            title: "Add tenant", eyebrow: "TENANTS", submit: "Create tenant", success: "Tenant account created.",
            intro: `<p class="muted" style="font-size:12px;margin:10px 0 0">Share the email and temporary password with your tenant. They can change it from My Profile.</p>`,
            fields: [
                { name: "name", label: "Full name", required: true, max: 100 },
                { name: "email", label: "Email", type: "email", required: true, max: 100, autocomplete: "off" },
                { name: "phone", label: "Phone", max: 30 },
                { name: "password", label: "Temporary password", type: "text", required: true, max: 100, autocomplete: "off", help: "At least 8 characters." },
                { name: "property_id", label: "Assign unit (optional)", type: "select", options: [{ value: "", label: "No unit yet" }, ...vacant.map(p => ({ value: p.id, label: `${p.building} · Unit ${p.unit_number}` }))] },
                { name: "monthly_rent", label: "Monthly rent (₱)", type: "number", min: 1, step: "0.01", help: "Required when a unit is selected." },
                { name: "start_date", label: "Lease start", type: "date", value: `${year}-01-01` },
                { name: "end_date", label: "Lease end", type: "date", value: `${year}-12-31` }
            ],
            onSubmit: async body => { await api("/api/tenants", { method: "POST", body }); C.staff = null; await refresh(); }
        });
    },

    editTenant(id) {
        const t = C.tenants.find(x => x.id === id);
        if (!t) return;
        openForm({
            title: "Edit tenant", eyebrow: "TENANTS", submit: "Save", success: "Tenant updated.",
            fields: [
                { name: "name", label: "Full name", required: true, max: 100, value: t.name },
                { name: "email", label: "Email", type: "email", required: true, max: 100, value: t.email, autocomplete: "off" },
                { name: "phone", label: "Phone", max: 30, value: t.phone || "" },
                { name: "password", label: "Reset password (optional)", max: 100, autocomplete: "off", help: "Leave blank to keep the current password." }
            ],
            onSubmit: async body => { await api(`/api/tenants/${id}`, { method: "PATCH", body }); await refresh(); }
        });
    },

    assignUnit(id) {
        const vacant = (C.properties || []).filter(p => !p.tenant_id);
        if (!vacant.length) return toast("No vacant units. Add a unit first.");
        const year = new Date().getFullYear();
        openForm({
            title: "Assign unit & start lease", eyebrow: "LEASES", submit: "Start lease", success: "Lease started.",
            fields: [
                { name: "property_id", label: "Unit", type: "select", required: true, options: vacant.map(p => ({ value: p.id, label: `${p.building} · Unit ${p.unit_number}` })) },
                { name: "monthly_rent", label: "Monthly rent (₱)", type: "number", required: true, min: 1, step: "0.01" },
                { name: "start_date", label: "Lease start", type: "date", required: true, value: `${year}-01-01` },
                { name: "end_date", label: "Lease end", type: "date", required: true, value: `${year}-12-31` }
            ],
            onSubmit: async body => { await api(`/api/tenants/${id}/lease`, { method: "POST", body }); await refresh(); }
        });
    },

    editLease(id) {
        const t = C.tenants.find(x => x.id === id);
        if (!t || !t.lease_id) return;
        openForm({
            title: `Lease · ${t.name}`, eyebrow: "LEASES", submit: "Save lease", success: "Lease updated.",
            fields: [
                { name: "monthly_rent", label: "Monthly rent (₱)", type: "number", required: true, min: 1, step: "0.01", value: t.monthly_rent },
                { name: "start_date", label: "Lease start", type: "date", required: true, value: t.start_date },
                { name: "end_date", label: "Lease end", type: "date", required: true, value: t.end_date }
            ],
            onSubmit: async body => { await api(`/api/leases/${t.lease_id}`, { method: "PATCH", body }); await refresh(); }
        });
    },

    async endLease(id) {
        const t = C.tenants.find(x => x.id === id);
        if (!t || !confirm(`End the lease for ${t.name}? The unit will become vacant.`)) return;
        try {
            await api(`/api/tenants/${id}/end-lease`, { method: "POST" });
            toast("Lease ended.");
            await refresh();
        } catch (err) { toast(err.message); }
    },

    addStaff() {
        openForm({
            title: "Add maintenance staff", eyebrow: "STAFF", submit: "Create account", success: "Staff account created.",
            fields: [
                { name: "name", label: "Full name", required: true, max: 100 },
                { name: "email", label: "Email", type: "email", required: true, max: 100, autocomplete: "off" },
                { name: "phone", label: "Phone", max: 30 },
                { name: "password", label: "Temporary password", required: true, max: 100, autocomplete: "off", help: "At least 8 characters." }
            ],
            onSubmit: async body => {
                await api("/api/staff", { method: "POST", body });
                C.staff = null;
                await refresh();
            }
        });
    }
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}

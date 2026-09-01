import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Resend } from 'resend';

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Serve uploads statically
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Serve React build safely
const distPath = path.join(process.cwd(), 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/admin')) {
      return next();
    }
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });
} else {
  app.get('/', (req, res) => {
    res.send('WASHO API is operational.');
  });
}

// PostgreSQL Connection
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }
    : {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'washo',
        password: process.env.DB_PASSWORD || 'your_password',
        port: parseInt(process.env.DB_PORT || '5432'),
      }
);

// Auto-Create Database Table & Verify Schema
const initDatabase = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        mobile VARCHAR(50) NOT NULL,
        vehicle_type VARCHAR(50) NOT NULL,
        vehicle_model VARCHAR(50) NOT NULL,
        vehicle_registration_number VARCHAR(50) NOT NULL,
        location VARCHAR(255) NOT NULL,
        flat_number VARCHAR(50) NOT NULL,
        preferred_service VARCHAR(100) NOT NULL,
        payment_image_url TEXT,
        status VARCHAR(50) DEFAULT 'Pending',
        source VARCHAR(50) DEFAULT 'website',
        timestamp VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Pending';`);
    console.log('PostgreSQL "leads" table verified/updated successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

initDatabase();

// Multer Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'payment-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and WEBP are allowed.'));
    }
  }
});

// Resend HTTP API Client
const resend = new Resend(process.env.RESEND_API_KEY);

// Auth Middleware Helper
const verifyAdminKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const key = req.query.key || req.headers['x-admin-key'];
  const SECRET_KEY = process.env.ADMIN_KEY || 'washo123';
  if (key !== SECRET_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// Admin API Routes
app.delete('/api/admin/leads/:id', verifyAdminKey, async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Lead deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Delete failed' });
  }
});

app.patch('/api/admin/leads/:id/status', verifyAdminKey, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE leads SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Status update failed' });
  }
});

app.put('/api/admin/leads/:id', verifyAdminKey, async (req, res) => {
  try {
    const { name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, status } = req.body;
    await pool.query(
      `UPDATE leads SET name=$1, email=$2, mobile=$3, vehicle_type=$4, vehicle_model=$5, vehicle_registration_number=$6, location=$7, flat_number=$8, preferred_service=$9, status=$10 WHERE id=$11`,
      [name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, status || 'Pending', req.params.id]
    );
    res.json({ success: true, message: 'Lead updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
});

app.post('/api/admin/leads', verifyAdminKey, async (req, res) => {
  try {
    const { name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, status } = req.body;
    await pool.query(
      `INSERT INTO leads (name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, status, source, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'admin', $11)`,
      [name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, status || 'Pending', new Date().toISOString()]
    );
    res.json({ success: true, message: 'Lead created' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Creation failed' });
  }
});

// iOS Glassmorphism Admin Interface
app.get('/admin', async (req, res) => {
  const adminKey = req.query.key;
  const SECRET_KEY = process.env.ADMIN_KEY || 'washo123';

  if (adminKey !== SECRET_KEY) {
    return res.status(401).send('<h1 style="text-align:center; margin-top:50px; font-family:-apple-system, sans-serif; color:#64748b;">401 Unauthorized</h1>');
  }

  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    const rows = result.rows;

    const pendingCount = rows.filter(r => (r.status || 'Pending') === 'Pending').length;
    const completedCount = rows.filter(r => r.status === 'Completed').length;

    let html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>WASHO Studio</title>
        <style>
          * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;
            background-color: #030712;
            color: #f3f4f6;
            margin: 0;
            padding: 0 16px 100px 16px;
            min-height: 100vh;
            overflow-x: hidden;
          }

          /* iOS Ambient Mesh Gradient Glows */
          body::before {
            content: '';
            position: fixed;
            top: -20vw;
            left: -10vw;
            width: 70vw;
            height: 70vw;
            background: radial-gradient(circle, rgba(37, 99, 235, 0.28) 0%, rgba(0, 0, 0, 0) 70%);
            z-index: -1;
            filter: blur(50px);
            pointer-events: none;
          }
          body::after {
            content: '';
            position: fixed;
            bottom: -20vw;
            right: -10vw;
            width: 80vw;
            height: 80vw;
            background: radial-gradient(circle, rgba(147, 51, 234, 0.22) 0%, rgba(0, 0, 0, 0) 70%);
            z-index: -1;
            filter: blur(60px);
            pointer-events: none;
          }

          /* iOS Glass Base Token */
          .glass {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(20px) saturate(190%);
            -webkit-backdrop-filter: blur(20px) saturate(190%);
            border: 1px solid rgba(255, 255, 255, 0.12);
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37), inset 0 1px 0 0 rgba(255, 255, 255, 0.15);
          }

          /* Sticky Header */
          .header-sticky {
            position: sticky;
            top: 0;
            z-index: 50;
            margin: 0 -16px 20px -16px;
            padding: 14px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(3, 7, 18, 0.65);
            backdrop-filter: blur(24px) saturate(200%);
            -webkit-backdrop-filter: blur(24px) saturate(200%);
          }
          .brand-title {
            font-size: 20px;
            font-weight: 800;
            letter-spacing: -0.5px;
            background: linear-gradient(135deg, #ffffff 30%, #93c5fd 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin: 0;
          }
          .brand-badge {
            font-size: 10px;
            font-weight: 700;
            padding: 3px 8px;
            border-radius: 20px;
            background: rgba(59, 130, 246, 0.2);
            color: #60a5fa;
            border: 1px solid rgba(59, 130, 246, 0.3);
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }

          /* Metrics Grid */
          .metrics-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin-bottom: 18px;
          }
          .metric-card {
            border-radius: 16px;
            padding: 14px 10px;
            text-align: center;
          }
          .metric-value {
            font-size: 22px;
            font-weight: 800;
            letter-spacing: -0.5px;
          }
          .metric-label {
            font-size: 11px;
            color: #9ca3af;
            font-weight: 500;
            margin-top: 3px;
          }

          /* Search & Filter Bar */
          .search-bar {
            margin-bottom: 20px;
          }
          .glass-input {
            width: 100%;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 14px;
            color: #ffffff;
            padding: 12px 16px;
            font-size: 14px;
            outline: none;
            transition: all 0.2s ease;
            backdrop-filter: blur(10px);
          }
          .glass-input:focus {
            border-color: rgba(59, 130, 246, 0.6);
            box-shadow: 0 0 16px rgba(59, 130, 246, 0.25);
            background: rgba(255, 255, 255, 0.09);
          }

          /* Cards Feed */
          .card-feed {
            display: flex;
            flex-direction: column;
            gap: 14px;
          }
          .lead-card {
            border-radius: 20px;
            padding: 18px;
            transition: transform 0.2s ease;
          }
          .lead-card:active {
            transform: scale(0.985);
          }
          .card-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
          }
          .cust-name {
            font-size: 17px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: -0.3px;
          }
          .cust-loc {
            font-size: 12px;
            color: #9ca3af;
            margin-top: 2px;
          }
          .service-pill {
            font-size: 11px;
            font-weight: 700;
            padding: 4px 10px;
            border-radius: 12px;
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(37, 99, 235, 0.1));
            color: #93c5fd;
            border: 1px solid rgba(147, 197, 253, 0.2);
          }

          .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            font-size: 13px;
            background: rgba(0, 0, 0, 0.2);
            padding: 12px;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.05);
            margin-bottom: 14px;
          }
          .info-cell {
            color: #9ca3af;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .info-cell strong {
            color: #e5e7eb;
            font-weight: 600;
          }

          /* iOS Glass Status Dropdown */
          .status-picker {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #f3f4f6;
            padding: 6px 12px;
            border-radius: 10px;
            font-size: 12px;
            font-weight: 600;
            outline: none;
            backdrop-filter: blur(10px);
          }

          /* Action Dock Buttons inside Card */
          .action-row {
            display: flex;
            gap: 8px;
            margin-top: 14px;
          }
          .btn-action {
            flex: 1;
            display: inline-flex;
            justify-content: center;
            align-items: center;
            padding: 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-decoration: none;
            border: none;
            cursor: pointer;
            transition: all 0.15s ease;
          }
          .btn-call { background: rgba(16, 185, 129, 0.18); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
          .btn-wa { background: rgba(34, 197, 94, 0.18); color: #86efac; border: 1px solid rgba(34, 197, 94, 0.3); }
          .btn-edit { background: rgba(255, 255, 255, 0.08); color: #d1d5db; border: 1px solid rgba(255, 255, 255, 0.12); }
          .btn-del { background: rgba(239, 68, 68, 0.18); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }

          /* Floating Glass Navigation Bar (iOS Dock) */
          .bottom-dock {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            width: calc(100% - 32px);
            max-width: 440px;
            padding: 8px;
            border-radius: 24px;
            display: flex;
            justify-content: space-around;
            align-items: center;
            z-index: 100;
          }
          .dock-btn {
            background: transparent;
            border: none;
            color: #9ca3af;
            font-size: 12px;
            font-weight: 600;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 3px;
            cursor: pointer;
            padding: 6px 16px;
            border-radius: 16px;
            transition: all 0.2s ease;
          }
          .dock-btn.active, .dock-btn:hover {
            color: #ffffff;
            background: rgba(255, 255, 255, 0.12);
          }

          /* Modal Styling */
          .modal-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            padding: 16px;
            align-items: center;
            justify-content: center;
            z-index: 200;
          }
          .modal-glass {
            border-radius: 24px;
            padding: 24px;
            width: 100%;
            max-width: 480px;
            max-height: 85vh;
            overflow-y: auto;
            background: rgba(17, 24, 39, 0.85);
          }
          .form-group { margin-bottom: 12px; }
          .form-group label { display: block; font-size: 12px; color: #9ca3af; font-weight: 600; margin-bottom: 4px; }
          .form-group input, .form-group select {
            width: 100%;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: #ffffff;
            padding: 10px 14px;
            border-radius: 12px;
            font-size: 14px;
            outline: none;
          }
        </style>
      </head>
      <body>
        <!-- Header -->
        <div class="header-sticky">
          <div style="display:flex; align-items:center; gap:10px;">
            <h1 class="brand-title">WASHO</h1>
            <span class="brand-badge">STUDIO</span>
          </div>
          <div style="font-size:12px; color:#9ca3af; font-weight:500;">Live Sync 🟢</div>
        </div>

        <!-- Metrics Grid -->
        <div class="metrics-grid">
          <div class="metric-card glass">
            <div class="metric-value" style="color: #ffffff;">${rows.length}</div>
            <div class="metric-label">Total Leads</div>
          </div>
          <div class="metric-card glass">
            <div class="metric-value" style="color: #f59e0b;">${pendingCount}</div>
            <div class="metric-label">Pending</div>
          </div>
          <div class="metric-card glass">
            <div class="metric-value" style="color: #10b981;">${completedCount}</div>
            <div class="metric-label">Completed</div>
          </div>
        </div>

        <!-- Search Bar -->
        <div class="search-bar">
          <input type="text" id="searchInput" class="glass-input" placeholder="🔍 Search leads by name, phone, reg no..." onkeyup="filterLeads()">
        </div>

        <!-- Lead Cards Feed -->
        <div class="card-feed" id="cardList">
    `;

    rows.forEach((lead) => {
      const cleanMobile = lead.mobile.replace(/\D/g, '');
      const waMsg = encodeURIComponent(`Hi ${lead.name}, thank you for choosing WASHO! Regarding your ${lead.preferred_service} booking for ${lead.vehicle_model} (${lead.vehicle_registration_number})...`);
      const status = lead.status || 'Pending';

      html += `
        <div class="lead-card glass lead-item" data-search="${(lead.name + ' ' + lead.mobile + ' ' + lead.vehicle_registration_number + ' ' + status).toLowerCase()}">
          <div class="card-top">
            <div>
              <div class="cust-name">${lead.name}</div>
              <div class="cust-loc">📍 Flat ${lead.flat_number}, ${lead.location}</div>
            </div>
            <span class="service-pill">${lead.preferred_service}</span>
          </div>

          <div class="info-grid">
            <div class="info-cell">🚗 <strong>${lead.vehicle_type}</strong> (${lead.vehicle_model})</div>
            <div class="info-cell">🔢 <strong>${lead.vehicle_registration_number}</strong></div>
            <div class="info-cell">📱 <strong>${lead.mobile}</strong></div>
            <div class="info-cell">✉️ <strong>${lead.email}</strong></div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:12px; color:#9ca3af; font-weight:600;">Status:</span>
              <select class="status-picker" onchange="updateStatus(${lead.id}, this.value)">
                <option value="Pending" ${status === 'Pending' ? 'selected' : ''}>Pending</option>
                <option value="Scheduled" ${status === 'Scheduled' ? 'selected' : ''}>Scheduled</option>
                <option value="Completed" ${status === 'Completed' ? 'selected' : ''}>Completed</option>
                <option value="Cancelled" ${status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
              </select>
            </div>
            ${lead.payment_image_url ? `<a href="${lead.payment_image_url}" target="_blank" style="font-size:12px; color:#60a5fa; font-weight:600; text-decoration:none;">🖼️ Receipt</a>` : ''}
          </div>

          <div class="action-row">
            <a href="tel:${lead.mobile}" class="btn-action btn-call">📞 Call</a>
            <a href="https://wa.me/91${cleanMobile}?text=${waMsg}" target="_blank" class="btn-action btn-wa">💬 WhatsApp</a>
            <button class="btn-action btn-edit" onclick='openEditModal(${JSON.stringify(lead)})'>✏️ Edit</button>
            <button class="btn-action btn-del" onclick="deleteLead(${lead.id})">🗑️</button>
          </div>
        </div>
      `;
    });

    html += `
        </div>

        <!-- Floating Glass Bottom Navigation Dock -->
        <div class="bottom-dock glass">
          <button class="dock-btn active" onclick="window.scrollTo({top: 0, behavior: 'smooth'})">
            <span style="font-size:16px;">🏠</span> Overivew
          </button>
          <button class="dock-btn" onclick="openAddModal()">
            <span style="font-size:16px;">➕</span> Add Lead
          </button>
          <button class="dock-btn" onclick="exportCSV()">
            <span style="font-size:16px;">📥</span> Export
          </button>
          <button class="dock-btn" onclick="location.reload()">
            <span style="font-size:16px;">🔄</span> Sync
          </button>
        </div>

        <!-- Add/Edit Modal -->
        <div class="modal-overlay" id="leadModal">
          <div class="modal-glass glass">
            <h3 id="modalTitle" style="margin-top:0; color:#fff; font-size:18px;">Booking Record</h3>
            <input type="hidden" id="editId">
            <div class="form-group"><label>Customer Name</label><input type="text" id="mName"></div>
            <div class="form-group"><label>Email Address</label><input type="email" id="mEmail"></div>
            <div class="form-group"><label>Mobile Phone</label><input type="text" id="mMobile"></div>
            <div class="form-group"><label>Vehicle Type</label><input type="text" id="mVehicleType"></div>
            <div class="form-group"><label>Vehicle Model</label><input type="text" id="mVehicleModel"></div>
            <div class="form-group"><label>Registration Number</label><input type="text" id="mRegNo"></div>
            <div class="form-group"><label>Location / Society</label><input type="text" id="mLocation"></div>
            <div class="form-group"><label>Flat Number</label><input type="text" id="mFlat"></div>
            <div class="form-group"><label>Service</label><input type="text" id="mService"></div>
            <div class="form-group"><label>Status</label>
              <select id="mStatus">
                <option value="Pending">Pending</option>
                <option value="Scheduled">Scheduled</option>
                <option value="Completed">Completed</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </div>
            
            <div style="display:flex; gap:10px; margin-top:20px;">
              <button class="btn-action" style="background:#2563eb; color:#fff;" onclick="saveLead()">Save Record</button>
              <button class="btn-action btn-edit" onclick="closeModal()">Cancel</button>
            </div>
          </div>
        </div>

        <script>
          const key = '${adminKey}';

          function filterLeads() {
            const query = document.getElementById('searchInput').value.toLowerCase();
            document.querySelectorAll('.lead-item').forEach(item => {
              const text = item.getAttribute('data-search');
              item.style.display = text.includes(query) ? 'block' : 'none';
            });
          }

          function updateStatus(id, newStatus) {
            fetch('/api/admin/leads/' + id + '/status?key=' + key, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: newStatus })
            })
            .then(res => res.json())
            .then(data => {
              if (!data.success) alert('Failed to update status');
            });
          }

          function deleteLead(id) {
            if (!confirm('Permanently delete this lead?')) return;
            fetch('/api/admin/leads/' + id + '?key=' + key, { method: 'DELETE' })
              .then(res => res.json())
              .then(data => {
                if (data.success) location.reload();
              });
          }

          function openAddModal() {
            document.getElementById('modalTitle').innerText = 'Add Manual Booking';
            document.getElementById('editId').value = '';
            document.getElementById('mName').value = '';
            document.getElementById('mEmail').value = '';
            document.getElementById('mMobile').value = '';
            document.getElementById('mVehicleType').value = '4-Wheeler';
            document.getElementById('mVehicleModel').value = '';
            document.getElementById('mRegNo').value = '';
            document.getElementById('mLocation').value = '';
            document.getElementById('mFlat').value = '';
            document.getElementById('mService').value = 'First Wash';
            document.getElementById('mStatus').value = 'Pending';
            document.getElementById('leadModal').style.display = 'flex';
          }

          function openEditModal(lead) {
            document.getElementById('modalTitle').innerText = 'Edit Booking Record';
            document.getElementById('editId').value = lead.id;
            document.getElementById('mName').value = lead.name;
            document.getElementById('mEmail').value = lead.email;
            document.getElementById('mMobile').value = lead.mobile;
            document.getElementById('mVehicleType').value = lead.vehicle_type;
            document.getElementById('mVehicleModel').value = lead.vehicle_model;
            document.getElementById('mRegNo').value = lead.vehicle_registration_number;
            document.getElementById('mLocation').value = lead.location;
            document.getElementById('mFlat').value = lead.flat_number;
            document.getElementById('mService').value = lead.preferred_service;
            document.getElementById('mStatus').value = lead.status || 'Pending';
            document.getElementById('leadModal').style.display = 'flex';
          }

          function closeModal() {
            document.getElementById('leadModal').style.display = 'none';
          }

          function saveLead() {
            const id = document.getElementById('editId').value;
            const payload = {
              name: document.getElementById('mName').value,
              email: document.getElementById('mEmail').value,
              mobile: document.getElementById('mMobile').value,
              vehicle_type: document.getElementById('mVehicleType').value,
              vehicle_model: document.getElementById('mVehicleModel').value,
              vehicle_registration_number: document.getElementById('mRegNo').value,
              location: document.getElementById('mLocation').value,
              flat_number: document.getElementById('mFlat').value,
              preferred_service: document.getElementById('mService').value,
              status: document.getElementById('mStatus').value,
            };

            const url = id ? ('/api/admin/leads/' + id + '?key=' + key) : ('/api/admin/leads?key=' + key);
            const method = id ? 'PUT' : 'POST';

            fetch(url, {
              method: method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            })
            .then(res => res.json())
            .then(data => {
              if (data.success) location.reload();
              else alert(data.message);
            });
          }

          function exportCSV() {
            const rows = ${JSON.stringify(rows)};
            let csv = "ID,Name,Email,Mobile,Vehicle Type,Model,Reg No,Location,Flat,Service,Status,Created At\\n";
            rows.forEach(r => {
              csv += '"' + r.id + '","' + (r.name||'') + '","' + (r.email||'') + '","' + (r.mobile||'') + '","' + (r.vehicle_type||'') + '","' + (r.vehicle_model||'') + '","' + (r.vehicle_registration_number||'') + '","' + (r.location||'') + '","' + (r.flat_number||'') + '","' + (r.preferred_service||'') + '","' + (r.status || 'Pending') + '","' + (r.created_at||'') + '"\\n';
            });
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.setAttribute('href', url);
            a.setAttribute('download', 'washo_leads.csv');
            a.click();
          }
        </script>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error loading admin interface.');
  }
});

// Public Lead Submission Endpoint
app.post('/api/leads', upload.single('paymentImage'), async (req, res) => {
  try {
    const {
      name, email, mobile, vehicleType, vehicleModel,
      vehicleRegistrationNumber, location, flatNumber, preferredService, source, timestamp
    } = req.body;

    if (!name || !email || !mobile || !vehicleType || !vehicleModel || !vehicleRegistrationNumber || !location || !flatNumber || !preferredService) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    let payment_image_url = null;
    if (preferredService !== 'First Wash') {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Payment screenshot is required for paid services.' });
      }
      payment_image_url = `/uploads/${req.file.filename}`;
    }

    // Save Lead to PostgreSQL
    const query = `
      INSERT INTO leads (
        name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, 
        location, flat_number, preferred_service, payment_image_url, status, source, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Pending', $11, $12) RETURNING id;
    `;
    
    const values = [
      name, email, mobile, vehicleType, vehicleModel, vehicleRegistrationNumber.trim(),
      location, flatNumber, preferredService, payment_image_url, source || 'website', timestamp || new Date().toISOString()
    ];

    const result = await pool.query(query, values);

    // Send Confirmation Email
    try {
      const emailData = await resend.emails.send({
        from: 'WASHO <booking@washo.online>',
        to: email,
        subject: `Booking Confirmed: ${preferredService} - WASHO`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px;">
            <h2 style="color: #2563eb; margin-top: 0;">Booking Confirmation</h2>
            <p>Hi <strong>${name}</strong>,</p>
            <p>Thank you for choosing WASHO! We have received your request and successfully registered your wash preference.</p>
            
            <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #1e293b; font-size: 16px;">Booking Summary:</h3>
              <ul style="list-style: none; padding: 0; margin: 0;">
                <li style="padding: 4px 0;"><strong>Selected Service:</strong> ${preferredService}</li>
                <li style="padding: 4px 0;"><strong>Vehicle:</strong> ${vehicleType} (${vehicleModel})</li>
                <li style="padding: 4px 0;"><strong>Registration No:</strong> ${vehicleRegistrationNumber}</li>
                <li style="padding: 4px 0;"><strong>Location:</strong> ${location}, Flat ${flatNumber}</li>
              </ul>
            </div>

            <p>Our team will reach out to you if any further coordination is required.</p>
            
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;" />
            <p style="font-size: 12px; color: #64748b; text-align: center;">
              This is an automated confirmation email from WASHO. Please do not reply directly to this message.
            </p>
          </div>
        `,
      });
      console.log('Confirmation email sent via Resend:', emailData);
    } catch (mailErr) {
      console.error('Failed to send confirmation email via Resend:', mailErr);
    }

    res.status(200).json({
      success: true,
      message: 'Lead saved successfully and confirmation email sent',
      id: result.rows[0].id
    });
  } catch (error) {
    console.error('Lead submission error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit lead. Please try again.' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
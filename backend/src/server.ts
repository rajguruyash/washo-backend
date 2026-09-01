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

// Resend Client
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

// Depo-Budget Full Width Dashboard Interface
app.get('/admin', async (req, res) => {
  const adminKey = req.query.key;
  const SECRET_KEY = process.env.ADMIN_KEY || 'washo123';

  if (adminKey !== SECRET_KEY) {
    return res.status(401).send('<h1 style="text-align:center; margin-top:50px; font-family:-apple-system, sans-serif; color:#64748b;">401 Unauthorized Access</h1>');
  }

  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    const rows = result.rows;

    const pendingCount = rows.filter(r => (r.status || 'Pending') === 'Pending').length;
    const scheduledCount = rows.filter(r => r.status === 'Scheduled').length;
    const completedCount = rows.filter(r => r.status === 'Completed').length;

    let html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WASHO Studio | Dashboard</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg-main: #090d16;
            --bg-card: #111726;
            --bg-subtle: #182032;
            --border: rgba(255, 255, 255, 0.08);
            --border-hover: rgba(255, 255, 255, 0.18);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            --accent-blue: #3b82f6;
            --accent-blue-soft: rgba(59, 130, 246, 0.12);
            --accent-emerald: #10b981;
            --accent-amber: #f59e0b;
            --radius-card: 16px;
            --radius-btn: 10px;
          }

          * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; }
          body { background-color: var(--bg-main); color: var(--text-primary); min-height: 100vh; -webkit-font-smoothing: antialiased; }

          /* App Layout */
          .dashboard-layout { display: flex; min-height: 100vh; width: 100%; }
          
          /* Left Sidebar */
          .sidebar {
            width: 250px;
            background-color: #0d121f;
            border-right: 1px solid var(--border);
            padding: 24px 20px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            position: fixed;
            top: 0; bottom: 0; left: 0;
            z-index: 20;
          }
          .brand-box { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
          .brand-logo { width: 32px; height: 32px; background: linear-gradient(135deg, #3b82f6, #1d4ed8); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; color: #fff; }
          .brand-name { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; }
          .brand-badge { font-size: 9px; font-weight: 700; background: var(--accent-blue-soft); color: var(--accent-blue); padding: 2px 6px; border-radius: 6px; text-transform: uppercase; border: 1px solid rgba(59, 130, 246, 0.2); }

          .nav-list { display: flex; flex-direction: column; gap: 6px; }
          .nav-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; color: var(--text-secondary); font-size: 14px; font-weight: 600; text-decoration: none; transition: all 0.2s; cursor: pointer; }
          .nav-item:hover, .nav-item.active { background: var(--bg-subtle); color: var(--text-primary); }
          .nav-item.active { border: 1px solid var(--border); }

          /* Main Section (Full Width Layout) */
          .main-wrapper {
            flex: 1;
            margin-left: 250px;
            padding: 32px 40px;
            width: calc(100% - 250px);
            box-sizing: border-box;
          }

          /* Header Bar */
          .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; width: 100%; }
          .page-title { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
          .page-sub { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
          .top-actions { display: flex; gap: 12px; }

          .btn-primary { background: var(--accent-blue); color: #fff; border: none; padding: 10px 18px; border-radius: var(--radius-btn); font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 8px; }
          .btn-primary:hover { background: #2563eb; transform: translateY(-1px); }
          .btn-secondary { background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border); padding: 10px 18px; border-radius: var(--radius-btn); font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 8px; }
          .btn-secondary:hover { border-color: var(--border-hover); background: var(--bg-subtle); }

          /* Metrics Cards Grid */
          .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; width: 100%; }
          .stat-card { background-color: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-card); padding: 20px; transition: border-color 0.2s; }
          .stat-card:hover { border-color: var(--border-hover); }
          .stat-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
          .stat-value { font-size: 28px; font-weight: 800; margin-top: 8px; letter-spacing: -0.5px; }

          /* Filter & Search Bar */
          .filter-bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; background: var(--bg-card); border: 1px solid var(--border); padding: 8px 12px; border-radius: 14px; width: 100%; }
          .search-input { background: transparent; border: none; outline: none; color: var(--text-primary); font-size: 14px; width: 380px; padding: 6px 8px; }
          .tabs-group { display: flex; gap: 4px; background: var(--bg-main); padding: 4px; border-radius: 10px; border: 1px solid var(--border); }
          .tab-btn { background: transparent; border: none; color: var(--text-secondary); padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
          .tab-btn.active, .tab-btn:hover { background: var(--bg-card); color: var(--text-primary); }

          /* Lead Grid View (Full Width Multi-Column) */
          .leads-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
            gap: 18px;
            width: 100%;
          }
          .lead-card {
            background-color: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius-card);
            padding: 20px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: all 0.2s ease;
          }
          .lead-card:hover { border-color: var(--border-hover); transform: translateY(-2px); box-shadow: 0 12px 24px rgba(0,0,0,0.3); }

          .lead-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
          .lead-name { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; color: #fff; }
          .lead-sub { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

          .service-tag {
            font-size: 11px;
            font-weight: 700;
            padding: 4px 10px;
            border-radius: 20px;
            background: var(--accent-blue-soft);
            color: #60a5fa;
            border: 1px solid rgba(59, 130, 246, 0.25);
            white-space: nowrap;
          }

          .details-list { background: var(--bg-main); border: 1px solid var(--border); border-radius: 12px; padding: 12px; font-size: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
          .detail-item { color: var(--text-secondary); }
          .detail-item strong { color: var(--text-primary); font-weight: 600; display: block; margin-top: 2px; }

          .card-actions { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
          
          .select-status {
            background: var(--bg-subtle);
            border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 6px 10px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            outline: none;
            cursor: pointer;
          }

          .action-buttons { display: flex; gap: 6px; }
          .icon-btn { width: 32px; height: 32px; border-radius: 8px; background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text-primary); display: flex; align-items: center; justify-content: center; text-decoration: none; cursor: pointer; transition: all 0.2s; font-size: 13px; }
          .icon-btn:hover { border-color: var(--border-hover); background: rgba(255, 255, 255, 0.1); }
          .icon-btn.danger:hover { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.4); color: #fca5a5; }

          /* Modal Styling */
          .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(8px); padding: 20px; align-items: center; justify-content: center; z-index: 100; }
          .modal-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: 20px; width: 100%; max-width: 480px; padding: 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          .form-group { margin-bottom: 14px; }
          .form-group label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
          .form-group input, .form-group select { width: 100%; background: var(--bg-main); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; color: #fff; font-size: 13px; outline: none; }
          .form-group input:focus { border-color: var(--accent-blue); }

          /* Responsive Tweaks */
          @media (max-width: 1024px) {
            .sidebar { display: none; }
            .main-wrapper { margin-left: 0; width: 100%; padding: 20px; }
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
          }
          @media (max-width: 640px) {
            .stats-grid { grid-template-columns: 1fr; }
            .filter-bar { flex-direction: column; align-items: stretch; }
            .search-input { width: 100%; }
          }
        </style>
      </head>
      <body>

        <div class="dashboard-layout">
          <!-- Left Navigation Sidebar -->
          <aside class="sidebar">
            <div>
              <div class="brand-box">
                <div class="brand-logo">W</div>
                <div>
                  <div class="brand-name">WASHO</div>
                  <div class="brand-badge">Studio CRM</div>
                </div>
              </div>

              <nav class="nav-list">
                <a class="nav-item active">📊 Overview</a>
                <a class="nav-item" onclick="openAddModal()">➕ Add Booking</a>
                <a class="nav-item" onclick="exportCSV()">📥 Export Data</a>
                <a class="nav-item" onclick="location.reload()">🔄 Sync Refresh</a>
              </nav>
            </div>

            <div style="font-size:12px; color:var(--text-muted); padding: 12px; background:var(--bg-card); border-radius:10px; border:1px solid var(--border);">
              🟢 System Live<br>
              <span style="font-size:10px;">Connected to PostgreSQL</span>
            </div>
          </aside>

          <!-- Main Content Area -->
          <main class="main-wrapper">
            
            <!-- Top Header -->
            <div class="top-bar">
              <div>
                <h1 class="page-title">Dashboard Overview</h1>
                <p class="page-sub">Manage wash service leads, schedules, and customer inquiries.</p>
              </div>
              <div class="top-actions">
                <button class="btn-secondary" onclick="exportCSV()">📥 Export CSV</button>
                <button class="btn-primary" onclick="openAddModal()">+ New Booking</button>
              </div>
            </div>

            <!-- Stats Grid -->
            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-label">Total Bookings</div>
                <div class="stat-value">${rows.length}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label" style="color:var(--accent-amber);">Pending</div>
                <div class="stat-value" style="color:var(--accent-amber);">${pendingCount}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label" style="color:var(--accent-blue);">Scheduled</div>
                <div class="stat-value" style="color:var(--accent-blue);">${scheduledCount}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label" style="color:var(--accent-emerald);">Completed</div>
                <div class="stat-value" style="color:var(--accent-emerald);">${completedCount}</div>
              </div>
            </div>

            <!-- Search and Filter Bar -->
            <div class="filter-bar">
              <input type="text" id="searchInput" class="search-input" placeholder="🔍  Search by name, phone, registration no..." onkeyup="filterLeads()">
              <div class="tabs-group">
                <button class="tab-btn active" onclick="setFilter('all', this)">All</button>
                <button class="tab-btn" onclick="setFilter('pending', this)">Pending</button>
                <button class="tab-btn" onclick="setFilter('scheduled', this)">Scheduled</button>
                <button class="tab-btn" onclick="setFilter('completed', this)">Completed</button>
              </div>
            </div>

            <!-- Cards Grid -->
            <div class="leads-grid" id="leadGrid">
    `;

    rows.forEach((lead) => {
      const cleanMobile = lead.mobile.replace(/\D/g, '');
      const waMsg = encodeURIComponent(`Hi ${lead.name}, regarding your ${lead.preferred_service} booking for ${lead.vehicle_model} (${lead.vehicle_registration_number})...`);
      const status = lead.status || 'Pending';

      html += `
        <div class="lead-card lead-item" data-status="${status.toLowerCase()}" data-search="${(lead.name + ' ' + lead.mobile + ' ' + lead.vehicle_registration_number + ' ' + status).toLowerCase()}">
          <div>
            <div class="lead-header">
              <div>
                <div class="lead-name">${lead.name}</div>
                <div class="lead-sub">📍 Flat ${lead.flat_number}, ${lead.location}</div>
              </div>
              <span class="service-tag">${lead.preferred_service}</span>
            </div>

            <div class="details-list">
              <div class="detail-item">Vehicle: <strong>${lead.vehicle_type} (${lead.vehicle_model})</strong></div>
              <div class="detail-item">Reg No: <strong>${lead.vehicle_registration_number}</strong></div>
              <div class="detail-item">Phone: <strong>${lead.mobile}</strong></div>
              <div class="detail-item">Email: <strong>${lead.email}</strong></div>
            </div>
          </div>

          <div>
            ${lead.payment_image_url ? `<div style="margin-bottom:12px;"><a href="${lead.payment_image_url}" target="_blank" style="font-size:12px; color:var(--accent-blue); font-weight:600; text-decoration:none;">📄 View Receipt Attachment</a></div>` : ''}

            <div class="card-actions">
              <select class="select-status" onchange="updateStatus(${lead.id}, this.value)">
                <option value="Pending" ${status === 'Pending' ? 'selected' : ''}>Pending</option>
                <option value="Scheduled" ${status === 'Scheduled' ? 'selected' : ''}>Scheduled</option>
                <option value="Completed" ${status === 'Completed' ? 'selected' : ''}>Completed</option>
                <option value="Cancelled" ${status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
              </select>

              <div class="action-buttons">
                <a href="tel:${lead.mobile}" class="icon-btn" title="Call Customer">📞</a>
                <a href="https://wa.me/91${cleanMobile}?text=${waMsg}" target="_blank" class="icon-btn" title="WhatsApp">💬</a>
                <button class="icon-btn" onclick='openEditModal(${JSON.stringify(lead)})' title="Edit Lead">✏️</button>
                <button class="icon-btn danger" onclick="deleteLead(${lead.id})" title="Delete Lead">🗑️</button>
              </div>
            </div>
          </div>
        </div>
      `;
    });

    html += `
            </div>
          </main>
        </div>

        <!-- Add/Edit Modal -->
        <div class="modal-overlay" id="leadModal">
          <div class="modal-box">
            <h3 id="modalTitle" style="margin-bottom: 20px; font-weight: 800; font-size: 18px;">Booking Record</h3>
            <input type="hidden" id="editId">
            <div class="form-group"><label>Customer Name</label><input type="text" id="mName"></div>
            <div class="form-group"><label>Email Address</label><input type="email" id="mEmail"></div>
            <div class="form-group"><label>Mobile Phone</label><input type="text" id="mMobile"></div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div class="form-group"><label>Vehicle Type</label><input type="text" id="mVehicleType"></div>
              <div class="form-group"><label>Vehicle Model</label><input type="text" id="mVehicleModel"></div>
            </div>
            <div class="form-group"><label>Registration Number</label><input type="text" id="mRegNo"></div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div class="form-group"><label>Location / Society</label><input type="text" id="mLocation"></div>
              <div class="form-group"><label>Flat Number</label><input type="text" id="mFlat"></div>
            </div>
            <div class="form-group"><label>Service Preferred</label><input type="text" id="mService"></div>
            <div class="form-group"><label>Status</label>
              <select id="mStatus">
                <option value="Pending">Pending</option>
                <option value="Scheduled">Scheduled</option>
                <option value="Completed">Completed</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </div>
            
            <div style="display:flex; gap:10px; margin-top:24px;">
              <button class="btn-primary" style="flex:1; justify-content:center;" onclick="saveLead()">Save Record</button>
              <button class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
          </div>
        </div>

        <script>
          const key = '${adminKey}';
          let currentTab = 'all';

          function setFilter(tab, element) {
            currentTab = tab;
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            element.classList.add('active');
            filterLeads();
          }

          function filterLeads() {
            const query = document.getElementById('searchInput').value.toLowerCase();
            document.querySelectorAll('.lead-item').forEach(item => {
              const text = item.getAttribute('data-search');
              const status = item.getAttribute('data-status');
              const matchesSearch = text.includes(query);
              const matchesTab = currentTab === 'all' || status === currentTab;

              item.style.display = (matchesSearch && matchesTab) ? 'flex' : 'none';
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
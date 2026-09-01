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

// Serve uploads statically using process.cwd()
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Serve built React frontend safely
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

// PostgreSQL Connection Config
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

// Auto-Create PostgreSQL Table on Startup
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
        source VARCHAR(50) DEFAULT 'website',
        timestamp VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('PostgreSQL "leads" table verified/created successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

initDatabase();

// Multer Storage Configuration
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

// Auth Middleware Helper for Admin APIs
const verifyAdminKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const key = req.query.key || req.headers['x-admin-key'];
  const SECRET_KEY = process.env.ADMIN_KEY || 'washo123';
  if (key !== SECRET_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// Admin API - Delete Lead
app.delete('/api/admin/leads/:id', verifyAdminKey, async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete lead' });
  }
});

// Admin API - Update Lead
app.put('/api/admin/leads/:id', verifyAdminKey, async (req, res) => {
  try {
    const { name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service } = req.body;
    await pool.query(
      `UPDATE leads SET name=$1, email=$2, mobile=$3, vehicle_type=$4, vehicle_model=$5, vehicle_registration_number=$6, location=$7, flat_number=$8, preferred_service=$9 WHERE id=$10`,
      [name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, req.params.id]
    );
    res.json({ success: true, message: 'Lead updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update lead' });
  }
});

// Admin API - Manual Add Lead
app.post('/api/admin/leads', verifyAdminKey, async (req, res) => {
  try {
    const { name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service } = req.body;
    await pool.query(
      `INSERT INTO leads (name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, source, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'admin', $10)`,
      [name, email, mobile, vehicle_type, vehicle_model, vehicle_registration_number, location, flat_number, preferred_service, new Date().toISOString()]
    );
    res.json({ success: true, message: 'Lead created successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create lead' });
  }
});

// Mobile Admin Dashboard Interface (CRUD Enabled)
app.get('/admin', async (req, res) => {
  const adminKey = req.query.key;
  const SECRET_KEY = process.env.ADMIN_KEY || 'washo123';

  if (adminKey !== SECRET_KEY) {
    return res.status(401).send('<h1 style="text-align:center; margin-top:50px; font-family:sans-serif;">401 Unauthorized</h1>');
  }

  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    const rows = result.rows;

    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WASHO Admin Panel</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 15px; background: #f1f5f9; margin: 0; }
          .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
          h2 { color: #0f172a; margin: 0; }
          .btn-add { background: #2563eb; color: white; padding: 8px 14px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
          .card { background: white; border-radius: 10px; padding: 15px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .title { font-weight: bold; font-size: 16px; color: #1e40af; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
          .field { margin: 4px 0; font-size: 14px; color: #334155; }
          .badge { background: #dbeafe; color: #1e40af; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
          .actions { display: flex; gap: 8px; margin-top: 12px; border-top: 1px solid #f1f5f9; padding-top: 10px; }
          .btn-edit { background: #e2e8f0; color: #1e293b; padding: 6px 12px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; flex: 1; }
          .btn-delete { background: #fee2e2; color: #991b1b; padding: 6px 12px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; flex: 1; }
          a { color: #2563eb; word-break: break-all; }
          
          /* Modal */
          .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); padding: 15px; box-sizing: border-box; align-items: center; justify-content: center; }
          .modal-content { background: white; border-radius: 10px; padding: 20px; width: 100%; max-width: 500px; max-height: 90vh; overflow-y: auto; }
          .form-group { margin-bottom: 10px; }
          .form-group label { display: block; font-size: 12px; font-weight: bold; color: #475569; margin-bottom: 4px; }
          .form-group input, .form-group select { width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box; }
          .modal-actions { display: flex; gap: 10px; margin-top: 15px; }
          .btn-save { background: #16a34a; color: white; padding: 10px; border: none; border-radius: 6px; flex: 1; font-weight: bold; cursor: pointer; }
          .btn-cancel { background: #94a3b8; color: white; padding: 10px; border: none; border-radius: 6px; flex: 1; font-weight: bold; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>WASHO Leads (${rows.length})</h2>
          <button class="btn-add" onclick="openAddModal()">+ Add Lead</button>
        </div>

        <div id="leadList">
    `;

    rows.forEach((lead) => {
      html += `
        <div class="card" id="lead-card-${lead.id}">
          <div class="title">${lead.name} <span class="badge">${lead.preferred_service}</span></div>
          <div class="field">📱 <strong>Phone:</strong> ${lead.mobile}</div>
          <div class="field">✉️ <strong>Email:</strong> ${lead.email}</div>
          <div class="field">🚗 <strong>Vehicle:</strong> ${lead.vehicle_type} - ${lead.vehicle_model} (${lead.vehicle_registration_number})</div>
          <div class="field">📍 <strong>Location:</strong> Flat ${lead.flat_number}, ${lead.location}</div>
          ${lead.payment_image_url ? `<div class="field">🖼️ <strong>Payment:</strong> <a href="${lead.payment_image_url}" target="_blank">View Screenshot</a></div>` : ''}
          <div class="field" style="color:#94a3b8; font-size:11px; margin-top:8px;">${new Date(lead.created_at).toLocaleString()}</div>
          
          <div class="actions">
            <button class="btn-edit" onclick='openEditModal(${JSON.stringify(lead)})'>✏️ Edit</button>
            <button class="btn-delete" onclick="deleteLead(${lead.id})">🗑️ Delete</button>
          </div>
        </div>
      `;
    });

    html += `
        </div>

        <!-- Add/Edit Modal -->
        <div class="modal" id="leadModal">
          <div class="modal-content">
            <h3 id="modalTitle">Edit Lead</h3>
            <input type="hidden" id="editId">
            <div class="form-group"><label>Name</label><input type="text" id="mName"></div>
            <div class="form-group"><label>Email</label><input type="email" id="mEmail"></div>
            <div class="form-group"><label>Mobile</label><input type="text" id="mMobile"></div>
            <div class="form-group"><label>Vehicle Type</label><input type="text" id="mVehicleType"></div>
            <div class="form-group"><label>Vehicle Model</label><input type="text" id="mVehicleModel"></div>
            <div class="form-group"><label>Reg Number</label><input type="text" id="mRegNo"></div>
            <div class="form-group"><label>Location</label><input type="text" id="mLocation"></div>
            <div class="form-group"><label>Flat Number</label><input type="text" id="mFlat"></div>
            <div class="form-group"><label>Preferred Service</label><input type="text" id="mService"></div>
            
            <div class="modal-actions">
              <button class="btn-save" onclick="saveLead()">Save</button>
              <button class="btn-cancel" onclick="closeModal()">Cancel</button>
            </div>
          </div>
        </div>

        <script>
          const key = '${adminKey}';

          function deleteLead(id) {
            if (!confirm('Are you sure you want to delete this lead?')) return;
            fetch('/api/admin/leads/' + id + '?key=' + key, { method: 'DELETE' })
              .then(res => res.json())
              .then(data => {
                if (data.success) location.reload();
                else alert('Error: ' + data.message);
              });
          }

          function openAddModal() {
            document.getElementById('modalTitle').innerText = 'Add New Lead';
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
            document.getElementById('leadModal').style.display = 'flex';
          }

          function openEditModal(lead) {
            document.getElementById('modalTitle').innerText = 'Edit Lead';
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
              else alert('Error: ' + data.message);
            });
          }
        </script>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error fetching leads from database.');
  }
});

// Main Public Lead Capture Endpoint
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
        location, flat_number, preferred_service, payment_image_url, source, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id;
    `;
    
    const values = [
      name, email, mobile, vehicleType, vehicleModel, vehicleRegistrationNumber.trim(),
      location, flatNumber, preferredService, payment_image_url, source || 'website', timestamp || new Date().toISOString()
    ];

    const result = await pool.query(query, values);

    // Send Automated Email via Resend
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
      console.log('Confirmation email sent successfully via Resend:', emailData);
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
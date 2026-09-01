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
app.use(cors({
  origin: true,
  credentials: true,
}));
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
    // Exclude API, uploads, and admin routes from React SPA fallback
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

// Multer Disk Storage Configuration
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

// Mobile-Friendly Admin Dashboard Route
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
        <title>WASHO Leads Admin</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 15px; background: #f4f6f8; margin: 0; }
          h2 { color: #1e293b; margin-bottom: 15px; }
          .card { background: white; border-radius: 8px; padding: 15px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .title { font-weight: bold; font-size: 16px; color: #2563eb; margin-bottom: 6px; }
          .field { margin: 4px 0; font-size: 14px; color: #334155; }
          .badge { background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
          a { color: #2563eb; word-break: break-all; }
        </style>
      </head>
      <body>
        <h2>WASHO Lead Dashboard (${rows.length})</h2>
    `;

    rows.forEach((lead) => {
      html += `
        <div class="card">
          <div class="title">${lead.name} <span class="badge">${lead.preferred_service}</span></div>
          <div class="field">📱 <strong>Phone:</strong> ${lead.mobile}</div>
          <div class="field">✉️ <strong>Email:</strong> ${lead.email}</div>
          <div class="field">🚗 <strong>Vehicle:</strong> ${lead.vehicle_type} - ${lead.vehicle_model} (${lead.vehicle_registration_number})</div>
          <div class="field">📍 <strong>Location:</strong> Flat ${lead.flat_number}, ${lead.location}</div>
          ${lead.payment_image_url ? `<div class="field">🖼️ <strong>Payment:</strong> <a href="${lead.payment_image_url}" target="_blank">View Screenshot</a></div>` : ''}
          <div class="field" style="color:#94a3b8; font-size:11px; margin-top:8px;">${new Date(lead.created_at).toLocaleString()}</div>
        </div>
      `;
    });

    html += `</body></html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error fetching leads from database.');
  }
});

// Leads Endpoint
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

    // 1. Save Lead to PostgreSQL
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

    // 2. Send Automated Confirmation Email via Resend REST API
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
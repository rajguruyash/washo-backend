import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import nodemailer from 'nodemailer';

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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and WEBP are allowed.'));
    }
  }
});

// Nodemailer Settings & Sanitization
const EMAIL_USER = process.env.EMAIL_USER || process.env.GMAIL_USER || 'contact.washo@gmail.com';
const rawPassword = process.env.EMAIL_PASS || process.env.GMAIL_APP_PASS || 'jfaz pqsk urbb lrrn';
const EMAIL_PASS = rawPassword.replace(/\s+/g, ''); // Strips spaces from App Passwords

// Explicit Nodemailer Transporter Configuration (Render Compatible)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // TLS
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// Verify SMTP Connection on Startup
transporter.verify((error) => {
  if (error) {
    console.error('SMTP Connection Error:', error);
  } else {
    console.log('SMTP Server is ready to send emails.');
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

    // 2. Send Automated Confirmation Email
    const mailOptions = {
      from: `"WASHO" <${EMAIL_USER}>`,
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
            This is an automated confirmation email. Please do not reply to this email.
          </p>
        </div>
      `,
    };

    // Non-blocking email send
    transporter.sendMail(mailOptions, (mailErr, info) => {
      if (mailErr) {
        console.error('Failed to send confirmation email:', mailErr);
      } else {
        console.log('Confirmation email sent successfully:', info.response);
      }
    });

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
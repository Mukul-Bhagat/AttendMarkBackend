import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';

// Force load .env
dotenv.config({ path: path.join(__dirname, '.env') });

async function testGmail() {
  console.log('--- GMAIL CONNECTION TEST ---');
  console.log('User:', process.env.SMTP_USER);
  // Show first 2 chars of password to verify it loaded
  const pass = process.env.SMTP_PASS || '';
  console.log('Pass:', pass.substring(0, 2) + '********' + pass.substring(pass.length - 2));

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    console.log('Attempting to verify connection...');
    await transporter.verify();
    console.log('✅ SUCCESS! Credentials are correct. Server is ready to take messages.');
  } catch (error: any) {
    console.error('❌ FAILED:', error.response || error.message);
    if (error.response && error.response.includes('535')) {
      console.error('-> This is strictly a Password/User mismatch. Regenerate your App Password.');
    }
  }
}

testGmail();


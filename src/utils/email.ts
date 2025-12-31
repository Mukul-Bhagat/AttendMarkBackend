import nodemailer from 'nodemailer';
import { htmlToText } from 'html-to-text';

// 1. Define the Options Interface
interface EmailOptions {
  email: string;
  subject: string;
  message: string; // The HTML message
}

// 2. Create the Transporter (Lazy Loading)
// We use a function so it reads process.env ONLY when called (after server startup)
const getTransporter = () => {
  // CRITICAL CHECK: Fail if credentials are missing
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error('❌ FATAL ERROR: Google App Credentials missing in .env');
    console.error('Please set SMTP_USER and SMTP_PASS in backend/.env');
    throw new Error('Missing Email Credentials');
  }

  return nodemailer.createTransport({
    host: 'smtp.gmail.com', // Force Gmail
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

// 3. The Send Email Function
export const sendEmail = async (options: EmailOptions): Promise<void> => {
  try {
    const transporter = getTransporter();

    // Convert HTML to plain text for spam prevention
    const text = htmlToText(options.message);

    const mailOptions = {
      from: `"AttendMark Support" <${process.env.SMTP_USER}>`, // Must match auth user
      to: options.email,
      subject: options.subject,
      html: options.message,
      text: text,
    };

    const info = await transporter.sendMail(mailOptions);
    
    console.log(`✅ Email sent to: ${options.email}`);
    console.log(`   Message ID: ${info.messageId}`);
  } catch (error: any) {
    console.error('❌ Error sending email:', error.message);
    if (error.code === 'EAUTH') {
      console.error('   -> Check your Gmail App Password and Email Address.');
    }
    // Don't crash the server, just log the error
  }
};

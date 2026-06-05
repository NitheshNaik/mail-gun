import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

console.log('Testing SMTP with:');
console.log('  HOST:', process.env.SMTP_HOST);
console.log('  PORT:', process.env.SMTP_PORT);
console.log('  USER:', process.env.SMTP_USER);
console.log('  PASS:', process.env.SMTP_PASS ? '✓ set (' + process.env.SMTP_PASS.length + ' chars)' : '✗ NOT SET');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

try {
  await transporter.verify();
  console.log('\n✓ SMTP connection successful!');
} catch (err) {
  console.error('\n✗ SMTP connection failed:');
  console.error('  Code:', err.code);
  console.error('  Message:', err.message);
}
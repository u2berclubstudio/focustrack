'use strict';

/* Sends the master admin's one-time codes.
 *
 * Configure with environment variables (Gmail example):
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_USER=you@gmail.com
 *   SMTP_PASS=<16-character Google app password, not your login password>
 *   MAIL_FROM="FocusTrack <you@gmail.com>"
 *
 * MAIL_MODE=capture keeps mail in memory instead of sending — used by tests.
 */

const MODE = process.env.MAIL_MODE || 'smtp';
const sent = [];   // capture mode only

let transport = null;
let transportError = null;

function getTransport() {
  if (transport || transportError) return transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transportError = new Error('SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)');
    return null;
  }
  try {
    const nodemailer = require('nodemailer');
    const port = Number(SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return transport;
  } catch (e) {
    transportError = e;
    return null;
  }
}

const isConfigured = () =>
  MODE === 'capture' || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

async function sendMail({ to, subject, text }) {
  if (MODE === 'capture') {
    sent.push({ to, subject, text, at: new Date().toISOString() });
    return { ok: true, mode: 'capture' };
  }

  const t = getTransport();
  if (!t) throw transportError || new Error('No mail transport');

  await t.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to, subject, text,
  });
  return { ok: true, mode: 'smtp' };
}

function otpEmail(code, minutes) {
  return {
    subject: `${code} is your FocusTrack sign-in code`,
    text:
`Your master admin sign-in code is:

    ${code}

It expires in ${minutes} minutes and can only be used once.

If you did not just try to sign in, someone has your PIN.
Change it on the server straight away with:

    node seed.js "<your name>" <new pin> <your email>
`,
  };
}

module.exports = { sendMail, isConfigured, otpEmail, sent, MODE };

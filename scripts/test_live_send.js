require('dotenv').config();
const { sendEmail } = require('../services/emailService');

async function testLiveEmail() {
    const targetEmail = process.argv[2] || process.env.BREVO_SENDER_EMAIL || process.env.USER_EMAIL || 'mashawer95@gmail.com';
    const brevoKey = (process.env.BREVO_API_KEY || '').trim();
    const brevoSender = (process.env.BREVO_SENDER_EMAIL || '').trim();

    console.log('═══════════════════════════════════════════════════════');
    console.log('📧 Mashawerr Live Email Diagnostic Test');
    console.log('═══════════════════════════════════════════════════════');
    console.log('Target recipient:', targetEmail);
    console.log('BREVO_API_KEY:   ', brevoKey ? `Configured (Length: ${brevoKey.length}, starts with: ${brevoKey.slice(0, 8)}...)` : '❌ NOT CONFIGURED');
    console.log('BREVO_SENDER:    ', brevoSender ? `✅ ${brevoSender}` : '⚠️ Not set (will fallback to USER_EMAIL)');
    console.log('USER_EMAIL:      ', process.env.USER_EMAIL || 'None');
    console.log('SMTP_HOST:       ', process.env.SMTP_HOST || 'None (Using Brevo/Gmail fallback)');
    console.log('───────────────────────────────────────────────────────');

    try {
        console.log(`Sending test email to ${targetEmail}...`);
        const result = await sendEmail({
            to: targetEmail,
            subject: 'Test Email from Mashawerr API - OTP Verification Test',
            html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #C19418; border-radius: 8px;">
                <h2 style="color: #C19418;">Mashawerr Email Test</h2>
                <p>If you see this email, your Brevo email integration is <strong>100% operational</strong>!</p>
                <div style="background: #f4f4f4; padding: 15px; border-radius: 6px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 4px; color: #111;">
                    123456
                </div>
                <p style="color: #777; font-size: 12px; margin-top: 20px;">Sent at: ${new Date().toISOString()}</p>
            </div>
            `,
        });
        console.log('✅ sendEmail succeeded:', result);
    } catch (err) {
        console.error('❌ sendEmail failed with error:');
        console.error(err.message);
    }
}

testLiveEmail();


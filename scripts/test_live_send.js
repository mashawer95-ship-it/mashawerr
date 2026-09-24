require('dotenv').config();
const { sendEmail, sendOrderCompletionEmail } = require('../services/emailService');

async function testLiveEmail() {
    console.log('Testing live email sending using env vars...');
    console.log('USER_EMAIL:', process.env.USER_EMAIL);
    console.log('SMTP_HOST:', process.env.SMTP_HOST || 'None (Using Gmail service fallback)');
    
    try {
        const result = await sendEmail({
            to: process.env.USER_EMAIL,
            subject: 'Test Email from Mashawerr API',
            html: '<h1>Test Email</h1><p>If you see this, email sending works!</p>'
        });
        console.log('✅ sendEmail succeeded:', result);
    } catch (err) {
        console.error('❌ sendEmail failed with error:', err);
    }
}

testLiveEmail();

const express = require('express');
const router = express.Router();
const {
    register,
    login,
    verifyEmail,
    resendOtp,
    changePassword,
    forgotPassword,
    verifyResetToken,
    verifyResetCode,
    resetPassword,
    refreshToken,
    logout,
} = require('../Controllers/authController');

const { googleSignIn, completeGoogleProfile } = require('../Controllers/googleAuthController');
const { authenticate } = require('../middlewares/verifytoken');
const { passwordResetLimiter, emailVerificationLimiter } = require('../middlewares/rateLimiter');

router.post('/register', register);
router.post('/login', login);
router.post('/verify-email', emailVerificationLimiter, verifyEmail);
router.post('/resend-otp', emailVerificationLimiter, resendOtp);
router.post('/change-password', changePassword);
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.get('/verify-reset-token/:token', verifyResetToken);
router.post('/verify-reset-code', verifyResetCode);
router.post('/reset-password', resetPassword);
router.post('/google-signin', googleSignIn);
router.post('/complete-google-profile', completeGoogleProfile);

// ─── Refresh Token Rotation ─────────────────────────────────────────────────
// POST /api/auth/refresh-token
//   Body: { refreshToken: "<raw-refresh-token>" }
//   Returns: { accessToken, refreshToken } (old token is invalidated = Rotation)
router.post('/refresh-token', refreshToken);

// POST /api/auth/logout  (requires valid accessToken in Authorization header)
//   Body: { refreshToken: "<raw-refresh-token>" }  (optional – revokes it in DB)
//   Returns: { message: 'Logged out successfully.' }
router.post('/logout', authenticate, logout);


// Diagnostic test endpoint for email sending
router.all('/test-email', async (req, res) => {
    const to = req.query.to || req.body?.to || 'amirashraf653@gmail.com';
    const { sendEmail } = require('../services/emailService');
    try {
        const result = await sendEmail({
            to,
            subject: 'Mashawerr API Live Email Diagnostic Test',
            html: `<div style="font-family: sans-serif; padding: 20px;"><h2>Mashawerr Email Test</h2><p>If you see this, email sending on your live server is 100% operational!</p></div>`,
        });
        res.json({
            success: true,
            message: `Email successfully dispatched to ${to}`,
            result,
            envConfig: {
                hasBrevoApiKey: !!process.env.BREVO_API_KEY,
                brevoSenderEmail: process.env.BREVO_SENDER_EMAIL || process.env.USER_EMAIL || 'amirashraf653@gmail.com',
                hasUserEmail: !!process.env.USER_EMAIL,
                hasUserPass: !!process.env.USER_PASS,
            },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            envConfig: {
                hasBrevoApiKey: !!process.env.BREVO_API_KEY,
                brevoSenderEmail: process.env.BREVO_SENDER_EMAIL || process.env.USER_EMAIL || 'amirashraf653@gmail.com',
                hasUserEmail: !!process.env.USER_EMAIL,
                hasUserPass: !!process.env.USER_PASS,
            },
        });
    }
});

module.exports = router;
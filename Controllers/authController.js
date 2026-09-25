const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // kept for OTP / reset token helpers
const {
    User,
    validateRegisterUser,
    validateLoginUser,
    validateVerifyEmail,
    validateResendOtp,
    validateChangePasswordByUserId,
    validateForgotPassword,
    validateVerifyResetCode,
    validateResetPassword,
} = require('../middlewares/User');
const {
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendPasswordResetLinkEmail,
    sendVerificationLinkEmail,
    dispatchBackgroundEmail,
    OTP_EXPIRY_MINUTES,
} = require('../services/emailService');
const { isBanned } = require('../services/bannedDeviceService');
const {
    generateAccessToken,
    generateRefreshToken,
    rotateRefreshToken,
    revokeRefreshToken,
    revokeAllUserTokens,
} = require('../services/tokenService');

const OTP_EXPIRY_MS = OTP_EXPIRY_MINUTES * 60 * 1000;
const RESEND_LIMIT_PER_HOUR = 3;
const ONE_HOUR_MS = 60 * 60 * 1000;


/** Generate 6-digit numeric OTP */
const generateOtp = () => crypto.randomInt(100000, 999999).toString();

/**
 * @description Register new user
 * @route POST /api/auth/register
 * @access public
 */
const register = asyncHandler(async (req, res) => {
    const { error } = validateRegisterUser(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { firstName, lastName, email, phone, password, governorate, gender } = req.body;
    const fcmToken = req.body?.fcmToken || req.headers['fcm-token'] || req.headers['x-fcm-token'];
    const deviceId = req.body?.deviceId || req.headers['x-device-id'];

    // Check if phone/device/fcmToken/email is banned
    const banCheck = await isBanned({ phone, fcmToken, deviceId, email });
    if (banCheck.isBanned) {
        return res.status(403).json({
            code: 'DEVICE_BLOCKED',
            message: 'عذراً، هذا الجهاز أو رقم الهاتف محظور من إنشاء حسابات جديدة. يرجى التواصل مع الدعم الفني.',
        });
    }

    // Check if user exists by email
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        return res.status(400).json({ message: 'Email already registered' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user (unverified)
    const otp = generateOtp();
    const emailVerificationExpires = new Date(Date.now() + OTP_EXPIRY_MS);

    const user = await User.create({
        firstName,
        lastName,
        email,
        phone,
        password: hashedPassword,
        deviceId: deviceId || null,
        governorate: governorate ? String(governorate).trim() : null,
        gender: gender ? String(gender).trim() : 'male',
        emailVerificationCode: otp,
        emailVerificationExpires,
    });

    dispatchBackgroundEmail(async () => {
        await sendVerificationEmail(email, otp, firstName);
    });

    res.status(201).json({
        message: 'Registration successful. Please check your email to verify your account.',
        email: user.email,
        userType: user.userType || 'NormalUser',
    });
});

/**
 * @description Login user
 * @route POST /api/auth/login
 * @access public
 */
const login = asyncHandler(async (req, res) => {
    const { error } = validateLoginUser(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { email, password } = req.body;

    // Find user
    const emailRegex = new RegExp(`^${email.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    let user = await User.findOne({ email: emailRegex });
    if (!user) {
        return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Check if account is suspended or blocked by admin
    if (user.isSuspended === true || user.status === 'blocked') {
        return res.status(403).json({
            code: 'ACCOUNT_SUSPENDED',
            message: 'عذراً، هذا الحساب موقوف من قبل الإدارة. يرجى التواصل مع الدعم الفني.',
        });
    }

    const fcmToken = req.body?.fcmToken || req.headers['fcm-token'] || req.headers['x-fcm-token'];
    const deviceId = req.body?.deviceId || req.headers['x-device-id'];

    // Check if device/phone/email is banned
    const banCheck = await isBanned({ phone: user.phone, fcmToken, deviceId: deviceId || user.deviceId, email: user.email });
    if (banCheck.isBanned) {
        return res.status(403).json({
            code: 'DEVICE_BLOCKED',
            message: 'عذراً، هذا الجهاز أو رقم الهاتف محظور من استخدام التطبيق. يرجى التواصل مع الدعم الفني.',
        });
    }

    // Update user deviceId if provided and changed
    if (deviceId && user.deviceId !== deviceId) {
        user.deviceId = deviceId;
        await user.save().catch((err) => console.warn('[Login] Failed to save deviceId:', err.message));
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (!user.isVerified) {
        return res.status(403).json({ message: 'Please verify your email first' });
    }

    // Generate tokens
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id, null, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
    });

    res.status(200).json({
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        governorate: user.governorate || null,
        gender: user.gender || null,
        isAdmin: user.isAdmin,
        userType: user.userType || 'NormalUser',
        accessToken,
        refreshToken,
        // Legacy field – kept for backward compat with older Flutter clients
        token: accessToken,
    });
});


/**
 * @description Verify email with OTP
 * @route POST /api/auth/verify-email
 * @access public
 */
const verifyEmail = asyncHandler(async (req, res) => {
    const { error } = validateVerifyEmail(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { email, code } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
        return res.status(400).json({ message: 'Invalid email or verification code' });
    }

    if (user.isVerified) {
        return res.status(400).json({ message: 'Email is already verified' });
    }

    if (user.emailVerificationCode !== code) {
        return res.status(400).json({ message: 'Invalid email or verification code' });
    }

    if (!user.emailVerificationExpires || new Date() > user.emailVerificationExpires) {
        return res.status(400).json({ message: 'Verification code has expired' });
    }

    user.isVerified = true;
    user.isProfileCompleted = true;
    user.emailVerificationCode = null;
    user.emailVerificationExpires = null;
    await user.save();

    // Generate tokens
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id, null, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
    });

    res.status(200).json({
        message: 'Email verified successfully',
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        governorate: user.governorate || null,
        gender: user.gender || null,
        isAdmin: user.isAdmin,
        userType: user.userType || 'NormalUser',
        accessToken,
        refreshToken,
        // Legacy field – kept for backward compat with older Flutter clients
        token: accessToken,
    });
});


/**
 * @description Resend OTP (max 3 per hour)
 * @route POST /api/auth/resend-otp
 * @access public
 */
const resendOtp = asyncHandler(async (req, res) => {
    const { error } = validateResendOtp(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
        return res.status(400).json({ message: 'No account found with this email' });
    }

    if (user.isVerified) {
        return res.status(400).json({ message: 'Email is already verified' });
    }

    const now = Date.now();
    if (user.otpResendLastAt && now - user.otpResendLastAt.getTime() < ONE_HOUR_MS) {
        if (user.otpResendCount >= RESEND_LIMIT_PER_HOUR) {
            return res.status(429).json({
                message: 'Too many requests. You can resend the code again in an hour.',
            });
        }
    } else {
        user.otpResendCount = 0;
        user.otpResendLastAt = new Date();
    }

    const otp = generateOtp();
    user.emailVerificationCode = otp;
    user.emailVerificationExpires = new Date(now + OTP_EXPIRY_MS);
    user.otpResendCount += 1;
    await user.save();

    dispatchBackgroundEmail(async () => {
        await sendVerificationEmail(email, otp, user.firstName);
    });

    res.status(200).json({
        message: 'Verification code sent. Please check your email.',
    });
});

/**
 * @description Change password – client sends userId + old password + new password; server verifies id
 * @route POST /api/auth/change-password
 * @access public
 */
const changePassword = asyncHandler(async (req, res) => {
    const { error } = validateChangePasswordByUserId(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { userId, oldPassword, newPassword } = req.body;

    const user = await User.findById(userId);
    if (!user) {
        return res.status(400).json({ message: 'Account not found' });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
        return res.status(400).json({ message: 'Old password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.passwordChangedAt = new Date();
    await user.save();

    res.status(200).json({ message: 'Password changed successfully' });
});

/**
 * @description Forgot password – Generate crypto 32-byte token, store SHA-256 hash in DB with 15m expiration, dispatch background email job, and return immediate generic anti-enumeration response.
 * @route POST /api/auth/forgot-password
 * @access public
 */
const forgotPassword = asyncHandler(async (req, res) => {
    const { error } = validateForgotPassword(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { email } = req.body;
    const genericResponseMessage = 'إذا كان هذا البريد الإلكتروني مسجلاً لدينا، ستتلقى رابطاً ورامزاً لإعادة تعيين كلمة المرور.';

    const cleanEmail = String(email || '').trim();
    const emailRegex = new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    const user = await User.findOne({ email: emailRegex });

    if (!user) {
        console.warn(`[ForgotPassword] ⚠️ Account not found in DB for email: '${cleanEmail}'. Returning generic response for anti-enumeration security.`);
        // Timing attack defense: Perform dummy bcrypt computation to keep response time consistent
        await bcrypt.compare('dummyPasswordToPreventTimingAttacks', '$2a$10$wO4eJ9m1234567890abcdefghijklmnopqrstuvwxyz12');
        return res.status(200).json({ message: genericResponseMessage });
    }

    // 1. Generate 32-byte cryptographically secure random token (64 hex characters)
    const rawToken = crypto.randomBytes(32).toString('hex');

    // 2. Compute SHA-256 hash of raw token for safe storage in DB
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // 3. Store hashed token in DB with 15-minute expiration & used: false
    user.passwordResetTokenHash = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 15 * 60 * 1000);
    user.passwordResetUsed = false;

    // Legacy OTP code support
    const code = generateOtp();
    user.passwordResetCode = code;
    await user.save();

    // 4. Dispatch Email Job to Background Worker Queue (Non-blocking response)
    dispatchBackgroundEmail(async () => {
        console.log(`[ForgotPassword] Dispatching OTP reset email to: ${user.email} (OTP: ${code})`);
        await sendPasswordResetEmail(user.email, code, user.firstName).catch(err => console.error('[ForgotPassword] OTP email error:', err.message));
    });

    // 5. Return immediate generic anti-account enumeration response
    return res.status(200).json({ message: genericResponseMessage });
});

/**
 * @description Verify reset token – Non-destructive GET request for UI inspection (prevents link burning by email preview scanners).
 * @route GET /api/auth/verify-reset-token/:token
 * @access public
 */
const verifyResetToken = asyncHandler(async (req, res) => {
    const rawToken = req.params.token || req.query.token;
    if (!rawToken || typeof rawToken !== 'string') {
        return res.status(400).json({ valid: false, message: 'رمز أو رابط غير صالح' });
    }

    const incomingHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const incomingBuffer = Buffer.from(incomingHash, 'hex');

    // Find candidate user matching hashed token
    const user = await User.findOne({
        passwordResetTokenHash: incomingHash,
        passwordResetExpires: { $gt: new Date() },
        passwordResetUsed: false,
    });

    if (!user) {
        return res.status(400).json({ valid: false, message: 'رابط إعادة تعيين كلمة المرور غير صالح أو انتهت صلاحيته' });
    }

    // Constant-time token comparison via crypto.timingSafeEqual
    const storedBuffer = Buffer.from(user.passwordResetTokenHash, 'hex');
    if (incomingBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(incomingBuffer, storedBuffer)) {
        return res.status(400).json({ valid: false, message: 'رابط إعادة تعيين كلمة المرور غير صالح' });
    }

    return res.status(200).json({
        valid: true,
        message: 'التوكن صالح ويمكن استخدامه لإعادة تعيين كلمة المرور',
        email: user.email,
    });
});

/**
 * @description Verify reset code (Legacy OTP flow) – confirms OTP and returns short-lived reset token
 * @route POST /api/auth/verify-reset-code
 * @access public
 */
const verifyResetCode = asyncHandler(async (req, res) => {
    const { error } = validateVerifyResetCode(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { email, code } = req.body;

    const cleanEmail = String(email || '').trim();
    const emailRegex = new RegExp(`^${cleanEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
    const user = await User.findOne({ email: emailRegex });

    if (!user) {
        return res.status(400).json({ message: 'Invalid email or verification code' });
    }

    if (user.passwordResetCode !== code) {
        return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    if (!user.passwordResetExpires || new Date() > user.passwordResetExpires) {
        return res.status(400).json({ message: 'Verification code has expired' });
    }

    // Issue a short-lived reset token (15 minutes)
    const resetToken = jwt.sign(
        { id: user._id, purpose: 'password-reset' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
    );

    res.status(200).json({
        message: 'Code verified successfully.',
        resetToken,
    });
});

/**
 * @description Reset password – Destructive POST request: validates raw token via crypto.timingSafeEqual, hashes new password with bcrypt, marks token as used, and invalidates all active user sessions across all devices.
 * @route POST /api/auth/reset-password
 * @access public
 */
const resetPassword = asyncHandler(async (req, res) => {
    const { error } = validateResetPassword(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const rawToken = req.body.token || req.body.resetToken;
    const { newPassword } = req.body;

    if (!rawToken) {
        return res.status(400).json({ message: 'Token is required' });
    }

    // Compute SHA-256 hash of incoming raw token
    const incomingHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const incomingBuffer = Buffer.from(incomingHash, 'hex');

    // 1. Lookup user by hashed token in DB
    let user = await User.findOne({
        passwordResetTokenHash: incomingHash,
        passwordResetExpires: { $gt: new Date() },
        passwordResetUsed: false,
    });

    if (user) {
        // Timing-safe comparison to prevent timing attacks
        const storedBuffer = Buffer.from(user.passwordResetTokenHash, 'hex');
        if (incomingBuffer.length !== storedBuffer.length || !crypto.timingSafeEqual(incomingBuffer, storedBuffer)) {
            return res.status(400).json({ message: 'رابط إعادة تعيين كلمة المرور غير صالح أو تم استخدامه مسبقاً' });
        }
    } else {
        // Fallback for JWT reset tokens issued via legacy OTP verification
        try {
            const decoded = jwt.verify(rawToken, process.env.JWT_SECRET);
            if (decoded.purpose === 'password-reset') {
                user = await User.findById(decoded.id);
            }
        } catch {
            // Handled below
        }
    }

    if (!user) {
        return res.status(400).json({ message: 'رابط أو رمز إعادة تعيين كلمة المرور غير صالح أو انتهت صلاحيته أو تم استخدامه مسبقاً' });
    }

    // 2. Hash new password with bcrypt
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    // 3. Mark token as consumed and wipe reset fields
    user.passwordResetUsed = true;
    user.passwordResetTokenHash = null;
    user.passwordResetExpires = null;
    user.passwordResetCode = null;

    // 4. Invalidate all active user sessions & refresh tokens across all devices
    user.passwordChangedAt = new Date();

    await user.save();

    return res.status(200).json({
        success: true,
        message: 'تم تغيير كلمة المرور بنجاح. تم إلغاء جميع الجلسات القديمة، يرجى تسجيل الدخول بكلمة المرور الجديدة.',
    });
});

/**
 * @description Rotate refresh token → return new access + refresh token pair.
 *              Old refresh token is invalidated immediately after use (rotation).
 *              Replay attack (reuse of revoked token) → entire session family is revoked.
 * @route  POST /api/auth/refresh-token
 * @access public (no authenticate middleware – token IS the credential)
 */
const refreshToken = asyncHandler(async (req, res) => {
    // Accept refresh token from body OR Authorization header (as fallback)
    const rawToken =
        req.body?.refreshToken ||
        req.headers['x-refresh-token'];

    if (!rawToken) {
        return res.status(400).json({
            code:    'REFRESH_TOKEN_MISSING',
            message: 'refreshToken is required in request body.',
        });
    }

    try {
        const { accessToken, refreshToken: newRefreshToken, user } = await rotateRefreshToken(rawToken, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });

        return res.status(200).json({
            message:      'Tokens refreshed successfully.',
            accessToken,
            refreshToken: newRefreshToken,
            // Legacy – kept for backward compat
            token:        accessToken,
            userType:     user.userType || 'NormalUser',
            isAdmin:      user.isAdmin,
        });
    } catch (err) {
        const statusMap = {
            REFRESH_TOKEN_EXPIRED: 401,
            REFRESH_TOKEN_INVALID: 401,
            REPLAY_ATTACK_DETECTED: 401,
            USER_NOT_FOUND: 401,
            ACCOUNT_SUSPENDED: 403,
        };
        const status = statusMap[err.code] || 401;
        return res.status(status).json({
            code:    err.code || 'REFRESH_FAILED',
            message: err.message,
        });
    }
});

/**
 * @description Logout – revoke the current refresh token so it cannot be reused.
 *              Access tokens expire naturally after 10 minutes.
 * @route  POST /api/auth/logout
 * @access private (authenticate middleware required)
 */
const logout = asyncHandler(async (req, res) => {
    const rawToken =
        req.body?.refreshToken ||
        req.headers['x-refresh-token'];

    if (rawToken) {
        try {
            await revokeRefreshToken(rawToken);
        } catch (e) {
            console.warn('[logout] Failed to revoke refresh token:', e.message);
        }
    }

    return res.status(200).json({
        message: 'Logged out successfully.',
    });
});

module.exports = {
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
};

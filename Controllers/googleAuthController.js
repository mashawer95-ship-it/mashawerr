const asyncHandler = require('express-async-handler');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken'); // kept for any legacy usage
const bcrypt = require('bcryptjs');
const { User } = require('../middlewares/User');
const { isBanned } = require('../services/bannedDeviceService');
const { generateAccessToken, generateRefreshToken } = require('../services/tokenService');


let isFirebaseInitialized = false;

function initFirebaseAdmin() {
    if (admin.apps.length > 0) {
        isFirebaseInitialized = true;
        return true;
    }

    try {
        let credential;
        const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

        if (rawEnv && String(rawEnv).trim()) {
            const serviceAccount = JSON.parse(rawEnv);
            if (typeof serviceAccount.private_key === 'string') {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            credential = admin.credential.cert(serviceAccount);
        } else {
            const fs = require('fs');
            const path = require('path');
            const localFile = path.join(__dirname, '../firebase-service-account.json');
            if (fs.existsSync(localFile)) {
                const serviceAccount = JSON.parse(fs.readFileSync(localFile, 'utf8'));
                if (typeof serviceAccount.private_key === 'string') {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }
                credential = admin.credential.cert(serviceAccount);
            } else {
                console.warn('⚠️ [Firebase] No FIREBASE_SERVICE_ACCOUNT env var or local firebase-service-account.json found.');
                return false;
            }
        }

        admin.initializeApp({ credential });
        isFirebaseInitialized = true;
        console.log('✅ Firebase Admin initialized');
        return true;
    } catch (e) {
        console.error('❌ Failed to initialize Firebase Admin:', e.message);
        return false;
    }
}

// Try initializing on startup
initFirebaseAdmin();

/**
 * @description Google Sign-In / Sign-Up via Firebase ID Token
 * @route POST /api/auth/google-signin
 * @access public
 */
const googleSignIn = asyncHandler(async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
        return res.status(400).json({ message: 'idToken is required' });
    }

    if (!initFirebaseAdmin()) {
        return res.status(500).json({
            message: 'خدمة تسجيل الدخول بجوجل غير مهيأة على السيرفر. يرجى إضافة FIREBASE_SERVICE_ACCOUNT في إعدادات السيرفر.',
        });
    }

    // ── 1. Verify Firebase ID Token ──────────────────────────────────────
    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
        console.error('❌ Firebase token verification failed:', err.message);
        return res.status(401).json({ message: 'Invalid or expired Google token' });
    }

    const { uid, email, name, picture } = decoded;

    if (!email) {
        return res.status(400).json({ message: 'Google account must have an email address' });
    }

    const fcmToken = req.body?.fcmToken || req.headers['fcm-token'] || req.headers['x-fcm-token'];
    const deviceId = req.body?.deviceId || req.headers['x-device-id'];

    try {
        // ── 2. Find or create user ────────────────────────────────────────────
        const emailRegex = new RegExp(`^${email.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
        let user = await User.findOne({ $or: [{ googleId: uid }, { email: emailRegex }] });

        // Check if device/email/fcmToken/phone is banned in the NEW BannedDevice system
        const banCheck = await isBanned({ email, fcmToken, deviceId: deviceId || user?.deviceId, phone: user?.phone });
        if (banCheck.isBanned) {
            return res.status(403).json({
                code: 'DEVICE_BLOCKED',
                message: 'عذراً، هذا الجهاز أو الحساب محظور من استخدام التطبيق. يرجى التواصل مع الدعم الفني.',
            });
        }

        if (user && (user.isSuspended === true || user.status === 'blocked')) {
            return res.status(403).json({
                code: 'ACCOUNT_SUSPENDED',
                message: 'عذراً، هذا الحساب موقوف من قبل الإدارة. يرجى التواصل مع الدعم الفني.',
            });
        }

        if (!user) {
            // New Google user → create account (no password, no phone yet)
            const nameParts = (name || '').split(' ');
            const firstName = nameParts[0] || 'Google';
            const lastName = nameParts.slice(1).join(' ') || 'User';

            user = await User.create({
                googleId: uid,
                email,
                firstName,
                lastName,
                profileImage: picture || null,
                deviceId: deviceId || null,
                isVerified: true,          // Google already verified the email
                isProfileCompleted: false, // User needs to add phone & password
            });

            console.log('✅ New Google user created:', user._id, email);
        } else {
            // Existing user → update googleId if missing & refresh profile image
            let changed = false;
            if (!user.googleId) { user.googleId = uid; changed = true; }
            if (picture && !user.profileImage) { user.profileImage = picture; changed = true; }
            if (!user.isVerified) { user.isVerified = true; changed = true; }
            if (deviceId && user.deviceId !== deviceId) { user.deviceId = deviceId; changed = true; }

            // Senior Logic: If user registered previously via email/password or already has phone/password, profile is complete!
            if (!user.isProfileCompleted && (user.phone || user.password || user.isVerified)) {
                user.isProfileCompleted = true;
                changed = true;
            }

            if (changed) await user.save();

            console.log('✅ Existing user signed in via Google:', user._id, email, 'isProfileCompleted:', user.isProfileCompleted);
        }

        // ── 3. Issue Access + Refresh tokens ───────────────────────────────────
        const accessToken  = generateAccessToken(user);
        const refreshToken = await generateRefreshToken(user._id, null, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });

        const profileCompletedFinal = Boolean(user.isProfileCompleted) || (Boolean(user.phone) && Boolean(user.phone.trim()));

        // ── 4. Return user data ────────────────────────────────────
        return res.status(200).json({
            _id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phone: user.phone || null,
            governorate: user.governorate || null,
            gender: user.gender || null,
            isAdmin: user.isAdmin,
            userType: user.userType || 'NormalUser',
            profileImage: user.profileImage || null,
            isProfileCompleted: profileCompletedFinal,
            accessToken,
            refreshToken,
            // Legacy – kept for backward compat with older Flutter clients
            token: accessToken,
        });
    } catch (err) {
        console.error('❌ [GoogleSignIn Error]:', err);
        return res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء معالجة تسجيل الدخول: ' + err.message,
            code: 'GOOGLE_SIGNIN_PROCESSING_ERROR',
            error: err.message,
        });
    }
});

/**
 * @description Complete profile for first-time Google users (set phone + password)
 * @route POST /api/auth/complete-google-profile
 * @access public (uses userId from body; user must already exist)
 *
 * Body: { userId, phone, password, confirmPassword }
 * - Saves hashed password so the user can later sign in via email/password
 * - Saves phone number
 * - Sets isProfileCompleted = true
 */
const completeGoogleProfile = asyncHandler(async (req, res) => {
    const { userId, phone, password, confirmPassword, governorate, gender } = req.body;

    // ── Validate required fields ──────────────────────────────────────────
    if (!userId || !phone || !password || !confirmPassword) {
        return res.status(400).json({
            message: 'userId, phone, password, and confirmPassword are required',
        });
    }

    const fcmToken = req.body?.fcmToken || req.headers['fcm-token'] || req.headers['x-fcm-token'];
    const deviceId = req.body?.deviceId || req.headers['x-device-id'];

    // Check if phone/device/fcmToken is banned
    const banCheck = await isBanned({ phone, fcmToken, deviceId });
    if (banCheck.isBanned) {
        return res.status(403).json({
            code: 'DEVICE_BLOCKED',
            message: 'عذراً، هذا الهاتف أو الجهاز محظور من إنشاء حسابات جديدة. يرجى التواصل مع الدعم الفني.',
        });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ message: 'Passwords do not match' });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    if (phone.length < 7 || phone.length > 20) {
        return res.status(400).json({ message: 'Phone number must be between 7 and 20 characters' });
    }

    // ── Find user ─────────────────────────────────────────────────────────
    const user = await User.findById(userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    // ── Hash password & update profile ───────────────────────────────────
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user.phone = phone;
    user.password = hashedPassword;
    if (governorate) user.governorate = String(governorate).trim();
    if (gender) user.gender = String(gender).trim();
    user.isProfileCompleted = true;
    await user.save();

    console.log('✅ Google user profile completed:', user._id, user.email, 'gov:', user.governorate, 'gender:', user.gender);

    // ── Issue refreshed Access + Refresh tokens ────────────────────────
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id, null, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
    });

    res.status(200).json({
        message: 'Profile completed successfully',
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        governorate: user.governorate || null,
        gender: user.gender || null,
        isAdmin: user.isAdmin,
        userType: user.userType || 'NormalUser',
        profileImage: user.profileImage || null,
        isProfileCompleted: true,
        accessToken,
        refreshToken,
        // Legacy – kept for backward compat with older Flutter clients
        token: accessToken,
    });
});

module.exports = { googleSignIn, completeGoogleProfile };

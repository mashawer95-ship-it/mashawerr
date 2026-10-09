const asyncHandler = require('express-async-handler');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken'); // kept for any legacy usage
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
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
        // ── 2. Find existing user ────────────────────────────────────────────
        const emailRegex = new RegExp(`^${email.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i');
        let user = await User.findOne({ $or: [{ googleId: uid }, { email: emailRegex }] });

        // Check if device/email/fcmToken/phone is banned in the BannedDevice system
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

        // Cleanup: If an incomplete orphan user was created previously without phone and without password,
        // remove it so they cannot bypass completion.
        if (user && (!user.phone || !user.phone.trim()) && !user.password) {
            console.log(`🧹 [GoogleSignIn] Removing incomplete orphan user from DB [${user._id}] ${email}`);
            await User.deleteOne({ _id: user._id });
            user = null;
        }

        const nameParts = (name || '').trim().split(' ');
        const firstName = nameParts[0] || 'Google';
        const lastName = nameParts.slice(1).join(' ') || 'User';
        const jwtSecret = process.env.JWT_SECRET || 'fallback_secret_mashaweer_auth';

        // ── 3. If User DOES NOT exist in DB: DO NOT CREATE THEM YET! ───────────
        // They must complete governorate, phone, password, and gender first.
        if (!user) {
            const registrationToken = jwt.sign(
                {
                    purpose: 'google_registration',
                    googleId: uid,
                    email: email.toLowerCase().trim(),
                    firstName,
                    lastName,
                    profileImage: picture || null,
                    deviceId: deviceId || null,
                },
                jwtSecret,
                { expiresIn: '1h' }
            );

            console.log(`ℹ️ [GoogleSignIn] New user identified (${email}). User NOT saved to DB yet pending profile completion.`);

            return res.status(200).json({
                success: true,
                isNewUser: true,
                isProfileCompleted: false,
                registrationToken,
                token: registrationToken,
                accessToken: registrationToken,
                _id: `pending_${uid}`,
                firstName,
                lastName,
                email: email.toLowerCase().trim(),
                profileImage: picture || null,
                governorate: null,
                gender: null,
                phone: null,
                userType: 'NormalUser',
                isAdmin: false,
                message: 'يرجى استكمال البيانات (المحافظة، كلمة المرور، رقم الهاتف، والنوع) لإنشاء الحساب.',
            });
        }

        // ── 4. Existing User: Check if profile is genuinely completed ──────────
        let changed = false;
        if (!user.googleId) { user.googleId = uid; changed = true; }
        if (picture && !user.profileImage) { user.profileImage = picture; changed = true; }
        if (!user.isVerified) { user.isVerified = true; changed = true; }
        if (deviceId && user.deviceId !== deviceId) { user.deviceId = deviceId; changed = true; }

        const isProfileComplete = Boolean(user.isProfileCompleted) && Boolean(user.phone && user.phone.trim()) && Boolean(user.password);

        if (!isProfileComplete) {
            if (changed) await user.save();
            const registrationToken = jwt.sign(
                {
                    purpose: 'google_registration',
                    userId: user._id.toString(),
                    googleId: uid,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    profileImage: user.profileImage,
                    deviceId: deviceId || user.deviceId,
                },
                jwtSecret,
                { expiresIn: '1h' }
            );

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
                isProfileCompleted: false,
                registrationToken,
                accessToken: registrationToken,
                token: registrationToken,
            });
        }

        if (changed) await user.save();

        console.log('✅ Existing user signed in via Google:', user._id, email, 'isProfileCompleted:', true);

        // ── 5. Issue Access + Refresh tokens for completed user ─────────────────
        const accessToken  = generateAccessToken(user);
        const refreshToken = await generateRefreshToken(user._id, null, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });

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
            isProfileCompleted: true,
            accessToken,
            refreshToken,
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
 * @description Complete profile for first-time Google users (set phone + password + governorate + gender)
 * @route POST /api/auth/complete-google-profile
 * @access public (uses registrationToken from body/header, or legacy userId)
 */
const completeGoogleProfile = asyncHandler(async (req, res) => {
    const {
        userId,
        registrationToken: bodyRegistrationToken,
        token: bodyToken,
        phone,
        password,
        confirmPassword,
        governorate,
        gender
    } = req.body;

    const tokenFromHeader = req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.split(' ')[1]
        : null;

    const regToken = bodyRegistrationToken || bodyToken || tokenFromHeader;

    // ── Validate required fields ──────────────────────────────────────────
    if (!phone || !password || !confirmPassword) {
        return res.status(400).json({
            message: 'رقم الهاتف، كلمة المرور، وتأكيد كلمة المرور مطلوبة',
        });
    }

    if (!regToken && !userId) {
        return res.status(400).json({
            message: 'رمز التسجيل (registrationToken) مطلوب لإكمال إنشاء الحساب',
        });
    }

    const cleanPhone = String(phone).trim();
    if (cleanPhone.length < 7 || cleanPhone.length > 25) {
        return res.status(400).json({ message: 'رقم الهاتف يجب أن يتكون من 7 إلى 25 حرفاً/رقماً' });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ message: 'كلمات المرور غير متطابقة' });
    }

    if (password.length < 6) {
        return res.status(400).json({ message: 'كلمة المرور يجب أن لا تقل عن 6 أحرف' });
    }

    const fcmToken = req.body?.fcmToken || req.headers['fcm-token'] || req.headers['x-fcm-token'];
    const deviceId = req.body?.deviceId || req.headers['x-device-id'];

    // Check if phone/device/fcmToken is banned
    const banCheck = await isBanned({ phone: cleanPhone, fcmToken, deviceId });
    if (banCheck.isBanned) {
        return res.status(403).json({
            code: 'DEVICE_BLOCKED',
            message: 'عذراً، هذا الهاتف أو الجهاز محظور من إنشاء حسابات جديدة. يرجى التواصل مع الدعم الفني.',
        });
    }

    // Check if phone number is already used by another active user
    const existingPhoneUser = await User.findOne({ phone: cleanPhone });
    if (existingPhoneUser && (!userId || existingPhoneUser._id.toString() !== String(userId))) {
        return res.status(400).json({
            message: 'رقم الهاتف مستخدم بالفعل بحساب آخر. يرجى استخدام رقم هاتف مختلف.',
            code: 'PHONE_ALREADY_EXISTS',
        });
    }

    // Normalize gender
    let normalizedGender = 'male';
    if (gender) {
        const g = String(gender).trim().toLowerCase();
        if (g === 'female' || g === 'أنثى' || g === 'انثى') {
            normalizedGender = 'female';
        } else {
            normalizedGender = 'male';
        }
    }

    const cleanGovernorate = governorate ? String(governorate).trim() : null;

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let user = null;

    // ── 1. If registrationToken is provided, decode and verify ─────────────
    if (regToken) {
        const jwtSecret = process.env.JWT_SECRET || 'fallback_secret_mashaweer_auth';
        let decodedPayload = null;
        try {
            decodedPayload = jwt.verify(regToken, jwtSecret);
        } catch (err) {
            console.warn('⚠️ [CompleteProfile] registrationToken verify error:', err.message);
        }

        if (decodedPayload && decodedPayload.purpose === 'google_registration') {
            const { googleId, email, firstName, lastName, profileImage, deviceId: tokenDeviceId, userId: payloadUserId } = decodedPayload;

            if (payloadUserId && mongoose.Types.ObjectId.isValid(payloadUserId)) {
                user = await User.findById(payloadUserId);
            }

            if (!user && (googleId || email)) {
                user = await User.findOne({
                    $or: [
                        ...(googleId ? [{ googleId }] : []),
                        ...(email ? [{ email: email.toLowerCase() }] : []),
                    ]
                });
            }

            if (!user) {
                // Check if email already taken
                const existingEmail = await User.findOne({ email: email.toLowerCase() });
                if (existingEmail) {
                    user = existingEmail;
                } else {
                    // NOW CREATE USER IN MONGO DB
                    user = await User.create({
                        googleId: googleId || undefined,
                        email: email.toLowerCase(),
                        firstName: firstName || 'Google',
                        lastName: lastName || 'User',
                        profileImage: profileImage || null,
                        phone: cleanPhone,
                        password: hashedPassword,
                        governorate: cleanGovernorate,
                        gender: normalizedGender,
                        deviceId: deviceId || tokenDeviceId || null,
                        isVerified: true,
                        isProfileCompleted: true,
                        status: 'active',
                        userType: 'NormalUser',
                        isAdmin: false,
                    });
                    console.log('🎉 [Google Complete Profile] New user successfully created in MongoDB:', user._id, user.email);
                }
            }
        }
    }

    // ── 2. Fallback to userId if user still not loaded ─────────────────────
    if (!user && userId && mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId);
    }

    if (!user) {
        return res.status(404).json({
            message: 'تعذر العثور على الحساب أو رمز التسجيل منتهي الصلاحية. يرجى تسجيل الدخول بجوجل مرة أخرى.',
            code: 'REGISTRATION_EXPIRED_OR_NOT_FOUND',
        });
    }

    // ── 3. Update user fields ──────────────────────────────────────────────
    user.phone = cleanPhone;
    user.password = hashedPassword;
    if (cleanGovernorate) user.governorate = cleanGovernorate;
    user.gender = normalizedGender;
    user.isProfileCompleted = true;
    user.isVerified = true;
    if (deviceId && !user.deviceId) user.deviceId = deviceId;
    await user.save();

    console.log('✅ Google user profile completed & saved in DB:', user._id, user.email, 'gov:', user.governorate, 'gender:', user.gender);

    // ── 4. Issue refreshed Access + Refresh tokens ─────────────────────────
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id, null, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
    });

    return res.status(200).json({
        message: 'تم إكمال البيانات بنجاح وإنشاء الحساب',
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

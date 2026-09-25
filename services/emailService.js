const nodemailer = require('nodemailer');

const OTP_EXPIRY_MINUTES = 10;

/**
 * Create Nodemailer Transporter based on environment variables
 */
const createTransporter = () => {
    // 1. Custom SMTP configuration
    if (process.env.SMTP_HOST) {
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000,
            auth: {
                user: process.env.SMTP_USER || process.env.USER_EMAIL,
                pass: process.env.SMTP_PASS || process.env.USER_PASS,
            },
        });
    }

    // 2. Gmail service using USER_EMAIL & USER_PASS
    if (process.env.USER_EMAIL && process.env.USER_PASS) {
        const passClean = process.env.USER_PASS.replace(/\s+/g, '');
        return nodemailer.createTransport({
            service: 'gmail',
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000,
            auth: {
                user: process.env.USER_EMAIL,
                pass: passClean,
            },
        });
    }

    return null;
};

/**
 * Send email via Resend / Nodemailer (Gmail / SMTP) / Brevo API / SendGrid
 */
const sendEmail = async ({ to, subject, html }) => {
    const fromEmail = process.env.BREVO_SENDER_EMAIL || process.env.SMTP_FROM || process.env.USER_EMAIL || 'amirashraf653@gmail.com';
    const fromName = process.env.CLINIC_NAME || 'Mashawerr';
    const from = `"${fromName}" <${fromEmail}>`;
    const errors = [];

    // 1. Try Brevo HTTP API first if BREVO_API_KEY is configured
    const brevoApiKey = process.env.BREVO_API_KEY;
    if (brevoApiKey) {
        try {
            console.log(`[EmailService] Attempting Brevo API send to ${to} (Sender: ${fromEmail})...`);
            const response = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'api-key': brevoApiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sender: { name: fromName, email: fromEmail },
                    to: [{ email: to }],
                    subject,
                    htmlContent: html,
                }),
            });

            if (response.ok) {
                const resData = await response.json().catch(() => ({}));
                console.log(`[EmailService] ✅ Email successfully sent via Brevo API to ${to} (messageId: ${resData.messageId || 'sent'})`);
                return { success: true, provider: 'brevo', messageId: resData.messageId };
            } else {
                const errorBody = await response.text();
                const errMsg = `Brevo API error ${response.status} (sender: ${fromEmail}): ${errorBody}`;
                console.error(`[EmailService] ❌ ${errMsg}`);
                errors.push(errMsg);
            }
        } catch (brevoErr) {
            const errMsg = `Brevo API exception: ${brevoErr.message}`;
            console.error(`[EmailService] ❌ ${errMsg}`);
            errors.push(errMsg);
        }
    }

    // 2. Try Resend API if RESEND_API_KEY is configured
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey) {
        try {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${resendApiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: process.env.RESEND_FROM || `${fromName} <onboarding@resend.dev>`,
                    to: [to],
                    subject,
                    html,
                }),
            });

            if (response.ok) {
                console.log(`[EmailService] ✅ Email successfully sent via Resend API to ${to}`);
                return { success: true, provider: 'resend' };
            } else {
                const errText = await response.text();
                const errMsg = `Resend API error ${response.status}: ${errText}`;
                console.error(`[EmailService] ❌ ${errMsg}`);
                errors.push(errMsg);
            }
        } catch (resendErr) {
            const errMsg = `Resend API error: ${resendErr.message}`;
            console.error(`[EmailService] ❌ ${errMsg}`);
            errors.push(errMsg);
        }
    }

    // 3. Try Nodemailer (SMTP / Gmail)
    const transporter = createTransporter();
    if (transporter) {
        try {
            await transporter.sendMail({
                from,
                to,
                subject,
                html,
            });
            console.log(`[EmailService] ✅ Email successfully sent via Nodemailer to ${to}`);
            return { success: true, provider: 'nodemailer' };
        } catch (smtpErr) {
            const errMsg = `Nodemailer failed to send email to ${to}: ${smtpErr.message}`;
            console.error(`[EmailService] ❌ ${errMsg}`);
            errors.push(errMsg);
        }
    }

    const failureSummary = `No email transport succeeded for ${to}. Errors: [${errors.join(' | ')}]. Check Railway env vars (BREVO_API_KEY + BREVO_SENDER_EMAIL, USER_EMAIL + USER_PASS).`;
    console.warn(`[EmailService] ⚠️ ${failureSummary}`);
    throw new Error(failureSummary);
};

/**
 * Build HTML email body for OTP verification
 */
const getVerificationEmailHtml = (otp, userName = 'there') => {
    const clinicName = process.env.CLINIC_NAME || 'Clinic';
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your email</title>
</head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.07);">
          <tr>
            <td style="padding: 32px 32px 24px; background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin:0; color: #ffffff; font-size: 22px; font-weight: 600;">${clinicName}</h1>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Email Verification</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px;">
              <p style="margin:0 0 16px; color: #374151; font-size: 16px; line-height: 1.5;">Hi ${userName},</p>
              <p style="margin:0 0 24px; color: #6b7280; font-size: 15px; line-height: 1.5;">Use the code below to verify your email address:</p>
              <div style="text-align: center; padding: 20px; background: #f0fdfa; border-radius: 8px; border: 1px solid #99f6e4;">
                <span style="font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0d9488;">${otp}</span>
              </div>
              <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">This code expires in <strong>${OTP_EXPIRY_MINUTES} minutes</strong>. Do not share it with anyone.</p>
              <p style="margin: 16px 0 0; color: #9ca3af; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin:0; color: #9ca3af; font-size: 12px;">&copy; ${new Date().getFullYear()} ${clinicName}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/**
 * Build HTML email body for password reset OTP
 */
const getPasswordResetEmailHtml = (otp, userName = 'there') => {
    const clinicName = process.env.CLINIC_NAME || 'Clinic';
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your password</title>
</head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.07);">
          <tr>
            <td style="padding: 32px 32px 24px; background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin:0; color: #ffffff; font-size: 22px; font-weight: 600;">${clinicName}</h1>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Reset Password</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px;">
              <p style="margin:0 0 16px; color: #374151; font-size: 16px; line-height: 1.5;">Hi ${userName},</p>
              <p style="margin:0 0 24px; color: #6b7280; font-size: 15px; line-height: 1.5;">Use the code below to reset your password:</p>
              <div style="text-align: center; padding: 20px; background: #f0fdfa; border-radius: 8px; border: 1px solid #99f6e4;">
                <span style="font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0d9488;">${otp}</span>
              </div>
              <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">This code expires in <strong>${OTP_EXPIRY_MINUTES} minutes</strong>. Do not share it with anyone.</p>
              <p style="margin: 16px 0 0; color: #9ca3af; font-size: 13px;">If you didn't request this, please ignore this email and secure your account.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin:0; color: #9ca3af; font-size: 12px;">&copy; ${new Date().getFullYear()} ${clinicName}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/**
 * Send verification OTP email
 * @param {string} to - Recipient email
 * @param {string} code - 6-digit OTP
 * @param {string} [userName] - Display name for greeting
 */
const sendVerificationEmail = async (to, code, userName) => {
    console.log(`[OTP] Verification Code for ${to}: ${code}`);

    const html = getVerificationEmailHtml(code, userName || 'there');
    await sendEmail({
        to,
        subject: 'Verify your email – Your verification code',
        html,
    });
};

/**
 * Send password reset OTP email
 * @param {string} to - Recipient email
 * @param {string} code - 6-digit OTP
 * @param {string} [userName] - Display name for greeting
 */
const sendPasswordResetEmail = async (to, code, userName) => {
    console.log(`[OTP] Password Reset Code for ${to}: ${code}`);

    const html = getPasswordResetEmailHtml(code, userName || 'there');
    await sendEmail({
        to,
        subject: 'Reset your password – Your verification code',
        html,
    });
};

/**
 * Dispatch email task to background execution (Non-blocking for API responses)
 */
const dispatchBackgroundEmail = (taskFn) => {
    setImmediate(async () => {
        try {
            await taskFn();
        } catch (err) {
            console.error('[EmailService Background Job Error]:', err.message);
        }
    });
};

/**
 * Build HTML email body for Password Reset Link
 */
const getPasswordResetLinkEmailHtml = (resetUrl, userName = 'there') => {
    const clinicName = process.env.CLINIC_NAME || 'Mashawerr';
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your password</title>
</head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.07);">
          <tr>
            <td style="padding: 32px 32px 24px; background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="margin:0; color: #ffffff; font-size: 22px; font-weight: 600;">${clinicName}</h1>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Password Reset Request</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px;">
              <p style="margin:0 0 16px; color: #374151; font-size: 16px; line-height: 1.5;">Hi ${userName},</p>
              <p style="margin:0 0 24px; color: #6b7280; font-size: 15px; line-height: 1.5;">We received a request to reset your password. Click the button below to set a new password:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" target="_blank" style="background-color: #0d9488; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; display: inline-block;">Reset Password</a>
              </div>
              <p style="margin: 24px 0 0; color: #6b7280; font-size: 14px; line-height: 1.5;">This link will expire in <strong>15 minutes</strong>. For security reasons, do not share this link with anyone.</p>
              <p style="margin: 16px 0 0; color: #9ca3af; font-size: 13px;">If you didn't request a password reset, you can safely ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin:0; color: #9ca3af; font-size: 12px;">&copy; ${new Date().getFullYear()} ${clinicName}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/**
 * Send password reset link email
 * @param {string} to - Recipient email
 * @param {string} token - Cryptographic raw token
 * @param {string} [userName] - Display name for greeting
 */
const sendPasswordResetLinkEmail = async (to, token, userName) => {
    const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://mashawerr.com';
    const resetUrl = `${baseUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
    console.log(`[PasswordReset] Reset Link generated for ${to}: ${resetUrl}`);

    const html = getPasswordResetLinkEmailHtml(resetUrl, userName || 'there');
    await sendEmail({
        to,
        subject: 'Reset your password – Mashawerr Security',
        html,
    });
};

/**
 * Send email verification link
 */
const sendVerificationLinkEmail = async (to, token, userName) => {
    const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://mashawerr.com';
    const verifyUrl = `${baseUrl.replace(/\/$/, '')}/verify-email?token=${token}`;
    console.log(`[EmailVerification] Verify Link generated for ${to}: ${verifyUrl}`);

    const html = getVerificationEmailHtml(token, userName || 'there');
    await sendEmail({
        to,
        subject: 'Verify your email – Mashawerr',
        html,
    });
};

/**
 * Helper to normalize any numeric price (in Fils or KD) to KD (KWD) with 3 decimals
 */
const normalizeToKD = (val) => {
    if (val == null || isNaN(val)) return 0;
    let num = Number(val);
    if (num <= 0) return 0;
    // Values in fils: divide by 1000. If already in KD (e.g. < 50 with fractional decimal), keep as KD
    if (num < 50 && num !== Math.round(num)) {
        return Number(num.toFixed(3));
    }
    return Number((num / 1000).toFixed(3));
};

/**
 * Format currency nicely for emails (KD or Fils) with thousands separators and 3 decimals (identical to CurrencyFormatter.formatFils)
 */
const formatKD = (val, unit = 'د.ك') => {
    const kd = normalizeToKD(val);
    const str = kd.toFixed(3);
    const parts = str.split('.');
    const intPart = parts[0].replace(/(\d{1,3})(?=(\d{3})+(?!\d))/g, '$1,');
    return `${intPart}.${parts[1]} ${unit}`;
};

/**
 * Generate Google Maps URL for coordinates or address string
 */
const getGoogleMapsUrl = (lat, lng, address) => {
    if (lat && lng && Number(lat) !== 0 && Number(lng) !== 0) {
        return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    }
    if (address && typeof address === 'string' && address.trim() && address.trim() !== 'غير محدد') {
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`;
    }
    return null;
};
/**
 * Ensure image URL is absolute for email clients
 */
const resolveImageUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    const baseUrl = process.env.BASE_URL || process.env.FRONTEND_URL || 'https://mashawerr.com';
    return `${baseUrl.replace(/\/$/, '')}/${trimmed.replace(/^\//, '')}`;
};

/**
 * Build HTML Email Template for Delivery Order Completion (RTL Senior Arabic Pure Black Design)
 * Brand Color: #C19418 (Golden Amber) | Pure Black Background (#000000) & Pure White Text (#ffffff)
 */
const getDeliveryOrderCompletionEmailHtml = (order, client = {}) => {
    const appName = process.env.CLINIC_NAME || 'مشاوير | Mashawerr';
    const clientName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'عميلنا العزيز';
    const orderId = order.orderId || order._id;
    
    // ─── التوقيت والتاريخ الصحيح بتوقيت الكويت/الخليج (Asia/Kuwait GMT+3) ─────────
    const dateObj = order.deliveredAt || order.updatedAt || order.createdAt || new Date();
    const dateStr = new Date(dateObj).toLocaleString('ar-KW', {
        timeZone: 'Asia/Kuwait',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
    
    // ─── حساب الأسعار بدقة (سعر التوصيل والخصم والإجمالي المدفوع) ───────────────────
    const rawDeliveryFee = order.totalDeliveryPrice ?? order.deliveryPrice ?? 0;
    const rawOrigDeliveryFee = order.originalDeliveryPrice;
    const rawDiscount = order.discountAmount ?? 0;
    const rawTotal = order.totalPrice;

    const deliveryFeeKD = normalizeToKD(rawDeliveryFee);
    const discountKD = normalizeToKD(rawDiscount);
    const origDeliveryFeeKD = rawOrigDeliveryFee != null
        ? normalizeToKD(rawOrigDeliveryFee)
        : (discountKD > 0 ? Number((deliveryFeeKD + discountKD).toFixed(3)) : deliveryFeeKD);

    let totalKD = 0;
    if (rawTotal != null && Number(rawTotal) > 0) {
        totalKD = normalizeToKD(rawTotal);
    } else {
        totalKD = Math.max(0, deliveryFeeKD - (rawOrigDeliveryFee != null ? 0 : discountKD));
        if (totalKD === 0 && deliveryFeeKD > 0) {
            totalKD = deliveryFeeKD;
        }
    }

    const hasDiscount = discountKD > 0;
    const deliveryFeeStr = formatKD(hasDiscount ? origDeliveryFeeKD : deliveryFeeKD);
    const discountStr = formatKD(discountKD);
    const totalFeeStr = formatKD(totalKD > 0 ? totalKD : deliveryFeeKD);
    const hasDiscountLine = hasDiscount && discountKD > 0;

    const tasks = Array.isArray(order.tasks) && order.tasks.length > 0 ? order.tasks : [];

    let tasksHtml = '';
    if (tasks.length > 0) {
        tasksHtml = tasks.map((task, idx) => {
            const pickupAddr = task.googleMapAddressFrom || task.pickupLocation?.streetName || task.pickupLocation?.address || 'غير محدد';
            const deliveryAddr = task.googleMapAddressTo || task.deliveryLocation?.streetName || task.deliveryLocation?.address || 'غير محدد';
            const desc = task.deliveryDescription || 'طلب توصيل بضاعة';

            const pickupMapUrl = getGoogleMapsUrl(task.fromLatitude, task.fromLongitude, pickupAddr);
            const deliveryMapUrl = getGoogleMapsUrl(task.toLatitude, task.toLongitude, deliveryAddr);

            const photoBefore = resolveImageUrl(task.itemPhotoBefore || task.pickupPhoto || order.pickupPhoto);
            const photoAfter = resolveImageUrl(task.itemPhotoAfter || task.deliveryPhoto || order.deliveryPhoto);

            return `
            <div style="background-color: #000000; border: 1px solid #C19418; border-radius: 12px; padding: 18px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed #C19418; padding-bottom: 10px; margin-bottom: 12px;">
                    <span style="font-weight: 700; color: #C19418; font-size: 15px;">📌 المهمة #${idx + 1}</span>
                    <span style="background-color: #000000; color: #C19418; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 20px; border: 1px solid #C19418;">مكتملة</span>
                </div>
                
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size: 14px; color: #ffffff; line-height: 1.6;">
                    <tr>
                        <td style="padding: 6px 0; font-weight: 700; color: #ffffff; width: 110px;">وصف المنتج:</td>
                        <td style="padding: 6px 0; color: #ffffff; font-weight: 500;">${desc}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-weight: 700; color: #ffffff; vertical-align: top;">🟢 من (الاستلام):</td>
                        <td style="padding: 6px 0; color: #ffffff;">
                            ${pickupAddr}
                            ${pickupMapUrl ? `
                                <div style="margin-top: 6px;">
                                    <a href="${pickupMapUrl}" target="_blank" style="display: inline-block; background-color: #C19418; color: #ffffff; text-decoration: none; font-size: 12px; font-weight: 700; padding: 5px 12px; border-radius: 6px; border: 1px solid #ffffff;">🗺️ فتح في خرائط جوجل</a>
                                </div>
                            ` : ''}
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-weight: 700; color: #ffffff; vertical-align: top;">🔵 إلي (التسليم):</td>
                        <td style="padding: 6px 0; color: #ffffff;">
                            ${deliveryAddr}
                            ${deliveryMapUrl ? `
                                <div style="margin-top: 6px;">
                                    <a href="${deliveryMapUrl}" target="_blank" style="display: inline-block; background-color: #C19418; color: #ffffff; text-decoration: none; font-size: 12px; font-weight: 700; padding: 5px 12px; border-radius: 6px; border: 1px solid #ffffff;">🗺️ فتح في خرائط جوجل</a>
                                </div>
                            ` : ''}
                        </td>
                    </tr>
                </table>

                ${(photoBefore || photoAfter) ? `
                <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid #C19418;">
                    <div style="font-size: 13px; font-weight: 700; color: #C19418; margin-bottom: 8px;">📷 صور إثبات التوصيل:</div>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            ${photoBefore ? `
                            <td align="center" style="width: 50%; padding-left: 6px;">
                                <div style="font-size: 11px; color: #ffffff; margin-bottom: 4px; font-weight: 600;">صورة الاستلام (قبل)</div>
                                <a href="${photoBefore}" target="_blank" style="text-decoration: none;">
                                    <img src="${photoBefore}" alt="صورة الاستلام" style="width: 100%; max-width: 180px; height: 120px; object-fit: cover; border-radius: 8px; border: 1px solid #C19418;" />
                                </a>
                            </td>
                            ` : ''}
                            ${photoAfter ? `
                            <td align="center" style="width: 50%; padding-right: 6px;">
                                <div style="font-size: 11px; color: #ffffff; margin-bottom: 4px; font-weight: 600;">صورة التسليم (بعد)</div>
                                <a href="${photoAfter}" target="_blank" style="text-decoration: none;">
                                    <img src="${photoAfter}" alt="صورة التسليم" style="width: 100%; max-width: 180px; height: 120px; object-fit: cover; border-radius: 8px; border: 1px solid #C19418;" />
                                </a>
                            </td>
                            ` : ''}
                        </tr>
                    </table>
                </div>
                ` : ''}
            </div>`;
        }).join('');
    } else {
        const rootBefore = resolveImageUrl(order.pickupPhoto || order.itemPhotoBefore);
        const rootAfter = resolveImageUrl(order.deliveryPhoto || order.itemPhotoAfter);
        tasksHtml = `
        <div style="background-color: #000000; border: 1px solid #C19418; border-radius: 12px; padding: 18px; margin-bottom: 16px;">
            <p style="margin: 0 0 10px; font-weight: 600; color: #ffffff;">تفاصيل التوصيل مكتملة بنجاح.</p>
            ${(rootBefore || rootAfter) ? `
            <div style="font-size: 13px; font-weight: 700; color: #C19418; margin-bottom: 8px;">📷 صور إثبات التوصيل:</div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                    ${rootBefore ? `<td align="center"><a href="${rootBefore}" target="_blank"><img src="${rootBefore}" style="max-width:180px; height:120px; object-fit:cover; border-radius:8px; border: 1px solid #C19418;" /></a></td>` : ''}
                    ${rootAfter ? `<td align="center"><a href="${rootAfter}" target="_blank"><img src="${rootAfter}" style="max-width:180px; height:120px; object-fit:cover; border-radius:8px; border: 1px solid #C19418;" /></a></td>` : ''}
                </tr>
            </table>
            ` : ''}
        </div>`;
    }

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>تفاصيل الطلب - ${appName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #000000; direction: rtl; text-align: right; color: #ffffff;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #000000; padding: 30px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #000000; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(193,148,24,0.15); border: 1px solid #C19418;">
          
          <!-- Header Banner with Brand Color #C19418 -->
          <tr>
            <td style="padding: 32px 28px; background-color: #C19418; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; text-shadow: 0 2px 4px rgba(0,0,0,0.3);">${appName}</h1>
              <p style="margin: 6px 0 0; color: #ffffff; font-size: 14px; font-weight: 600;">فاتورة وتفاصيل طلب التوصيل المكتمل</p>
            </td>
          </tr>

          <!-- Success Alert Header (Pure Black background, Gold Border, White Text) -->
          <tr>
            <td style="padding: 24px 28px 12px;">
              <div style="background-color: #000000; border: 1px solid #C19418; border-radius: 12px; padding: 18px; text-align: center;">
                <h2 style="margin: 0 0 6px; color: #C19418; font-size: 20px; font-weight: 800;">تم توصيل طلبك بنجاح</h2>
                <p style="margin: 0; color: #ffffff; font-size: 14px; line-height: 1.5;">مرحبًا ${clientName}، شكراً لاستخدامك خدماتنا. إليك جميع تفاصيل الطلب:</p>
              </div>
            </td>
          </tr>

          <!-- Order Summary Header Info -->
          <tr>
            <td style="padding: 12px 28px 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #000000; border-radius: 10px; padding: 14px; font-size: 13px; color: #ffffff; border: 1px solid #C19418;">
                <tr>
                  <td style="font-weight: 700; color: #ffffff;">رقم الطلب: <span style="color: #C19418;">#${orderId}</span></td>
                  <td align="left" style="color: #ffffff; font-weight: 500;">تاريخ الإتمام: <span style="color: #ffffff;">${dateStr}</span></td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tasks & Delivery Details -->
          <tr>
            <td style="padding: 0 28px 16px;">
              <h3 style="margin: 0 0 14px; color: #C19418; font-size: 16px; font-weight: 700; border-bottom: 2px solid #C19418; padding-bottom: 6px; display: inline-block;">🚚 تفاصيل التوصيل والمواقع</h3>
              ${tasksHtml}
            </td>
          </tr>

          <!-- Price & Payment Summary -->
          <tr>
            <td style="padding: 0 28px 28px;">
              <h3 style="margin: 0 0 14px; color: #C19418; font-size: 16px; font-weight: 700; border-bottom: 2px solid #C19418; padding-bottom: 6px; display: inline-block;">💳 الملخص المالي</h3>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #000000; border: 1px solid #C19418; border-radius: 12px; padding: 18px; font-size: 14px; color: #ffffff;">
                <tr>
                  <td style="padding: 8px 0; color: #ffffff; font-weight: 700;">سعر التوصيل:</td>
                  <td align="left" style="padding: 8px 0; color: #ffffff; font-weight: 600;">${deliveryFeeStr}</td>
                </tr>
                ${hasDiscount ? `
                <tr>
                  <td style="padding: 8px 0; color: #ffffff; font-weight: 700;">الخصم المطبق:</td>
                  <td align="left" style="padding: 8px 0; color: #ffffff; font-weight: 600;">- ${discountStr}</td>
                </tr>
                ` : ''}
                <tr style="border-top: 1px dashed #C19418;">
                  <td style="padding: 14px 0 4px; font-weight: 700; color: #ffffff; font-size: 16px;">الإجمالي المدفوع:</td>
                  <td align="left" style="padding: 14px 0 4px; font-weight: 800; color: #C19418; font-size: 20px;">${totalFeeStr}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 28px; background-color: #000000; text-align: center; border-top: 1px solid #C19418;">
              <p style="margin: 0 0 6px; color: #ffffff; font-size: 12px;">إذا كان لديك أي استفسار، يسعدنا تواصلك معنا دائمًا عبر الدعم الفني.</p>
              <p style="margin: 0; color: #ffffff; font-size: 11px;">&copy; ${new Date().getFullYear()} ${appName}. جميع الحقوق محفوظة.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/**
 * Send regular delivery order completion email to client
 * @param {object|string|number} orderIdOrDoc - Order document or Order ID
 */
const sendDeliveryOrderCompletionEmail = async (orderIdOrDoc) => {
    const { Order } = require('../middlewares/Order');
    const { User } = require('../middlewares/User');
    const mongoose = require('mongoose');

    let order = null;

    // ─── STEP 1: RESOLVE DELIVERY ORDER ───────────────────────────────────────
    if (typeof orderIdOrDoc === 'object' && orderIdOrDoc !== null) {
        order = orderIdOrDoc;
    } else if (orderIdOrDoc) {
        const numId = !isNaN(Number(orderIdOrDoc)) ? Number(orderIdOrDoc) : -1;
        const isValidObjId = mongoose.isValidObjectId(orderIdOrDoc);

        order = await Order.findOne({
            $or: [
                ...(numId > 0 ? [{ orderId: numId }] : []),
                ...(isValidObjId ? [{ _id: orderIdOrDoc }] : [])
            ]
        }).lean();
    }

    if (!order || typeof order !== 'object') {
        console.warn('[EmailService] ⚠️ Delivery order completion email skipped: Order not found for input:', orderIdOrDoc);
        return { success: false, reason: 'order_not_found' };
    }

    // ─── STEP 2: RESOLVE CLIENT EMAIL ─────────────────────────────────────────
    const clientId = order.clientId || order.userId || order.user;
    let client = null;

    if (clientId) {
        try {
            if (mongoose.isValidObjectId(clientId)) {
                client = await User.findById(clientId).lean();
            } else {
                client = await User.findOne({ $or: [{ _id: clientId }, { id: clientId }] }).lean();
            }
        } catch (err) {
            console.warn(`[EmailService] Could not fetch User by id ${clientId}:`, err.message);
        }
    }

    const recipientEmail = client?.email || order.userInfo?.email || order.clientEmail || order.email;
    if (!recipientEmail) {
        console.warn(`[EmailService] ⚠️ Delivery Order #${order.orderId} has no client email attached (ClientId: ${clientId}). Email skipped.`);
        return { success: false, reason: 'no_client_email' };
    }

    // ─── STEP 3: RESOLVE PICKUP & DELIVERY PROOF PHOTOS (POD & TASKS) ────────
    try {
        const { DeliverySession } = require('../models/DeliverySession');
        const { DeliveryAttempt } = require('../models/DeliveryAttempt');

        const sessionId = order.activeDeliverySessionId || order.deliverySessionId;
        let targetSessionId = sessionId;

        if (!targetSessionId && order.orderId) {
            const sess = await DeliverySession.findOne({
                $or: [
                    { orderId: String(order.orderId) },
                    { orderId: Number(order.orderId) },
                    { orderId: String(order._id) },
                    { orderId: order._id }
                ]
            }).sort({ createdAt: -1 }).lean();
            if (sess) targetSessionId = sess.sessionId;
        }

        if (targetSessionId) {
            // 1. Delivery Proof Photo (After)
            let deliveryAttempt = await DeliveryAttempt.findOne({
                sessionId: targetSessionId,
                phase: { $in: ['DELIVERY', 'delivery'] },
                state: { $in: ['APPROVED', 'WAITING_CUSTOMER_REVIEW', 'COMPLETED'] }
            }).sort({ createdAt: -1 }).lean();

            if (!deliveryAttempt) {
                deliveryAttempt = await DeliveryAttempt.findOne({
                    sessionId: targetSessionId,
                    phase: { $in: ['DELIVERY', 'delivery'] }
                }).sort({ createdAt: -1 }).lean();
            }

            if (deliveryAttempt && deliveryAttempt.photo) {
                const p = deliveryAttempt.photo;
                const photoUrl = p.cdnUrl || p.url || p.secure_url || (p.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${p.objectKey}` : null);
                if (photoUrl) {
                    if (!order.deliveryPhoto) order.deliveryPhoto = photoUrl;
                    if (!order.itemPhotoAfter) order.itemPhotoAfter = photoUrl;
                    if (Array.isArray(order.tasks) && order.tasks.length > 0) {
                        order.tasks.forEach(t => {
                            if (!t.itemPhotoAfter && !t.deliveryPhoto) {
                                t.itemPhotoAfter = photoUrl;
                                t.deliveryPhoto = photoUrl;
                            }
                        });
                    }
                }
            }

            // 2. Pickup Proof Photo (Before)
            let pickupAttempt = await DeliveryAttempt.findOne({
                sessionId: targetSessionId,
                phase: { $in: ['PICKUP', 'pickup'] }
            }).sort({ createdAt: -1 }).lean();

            if (pickupAttempt && pickupAttempt.photo) {
                const p = pickupAttempt.photo;
                const photoUrl = p.cdnUrl || p.url || p.secure_url || (p.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${p.objectKey}` : null);
                if (photoUrl) {
                    if (!order.pickupPhoto) order.pickupPhoto = photoUrl;
                    if (!order.itemPhotoBefore) order.itemPhotoBefore = photoUrl;
                    if (Array.isArray(order.tasks) && order.tasks.length > 0) {
                        order.tasks.forEach(t => {
                            if (!t.itemPhotoBefore && !t.pickupPhoto) {
                                t.itemPhotoBefore = photoUrl;
                                t.pickupPhoto = photoUrl;
                            }
                        });
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[EmailService] Warning resolving delivery session photos:', err.message);
    }

    // ─── STEP 4: BUILD HTML & DISPATCH ─────────────────────────────────────────
    try {
        const subject = `📦 تفاصيل وفاتورة طلب التوصيل المكتمل #${order.orderId}`;
        const html = getDeliveryOrderCompletionEmailHtml(order, client || {});

        console.log(`[EmailService] ✉️ Dispatching delivery order completion email to ${recipientEmail} for Order #${order.orderId}...`);

        return await sendEmail({
            to: recipientEmail,
            subject,
            html,
        });
    } catch (err) {
        console.error('[EmailService] ❌ Failed to send delivery order completion email:', err.message);
        throw err;
    }
};

const getBusinessOrderCompletionEmailHtml = () => '';

const sendBusinessOrderCompletionEmail = async () => {
    return { success: false, reason: 'business_orders_disabled' };
};

/**
 * Order completion email dispatcher (Delivery-only)
 * @param {object|string|number} orderIdOrDoc - Order document or Order ID
 */
const sendOrderCompletionEmail = async (orderIdOrDoc) => {
    return await sendDeliveryOrderCompletionEmail(orderIdOrDoc);
};

module.exports = {
    sendEmail,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendPasswordResetLinkEmail,
    sendVerificationLinkEmail,
    sendDeliveryOrderCompletionEmail,
    sendBusinessOrderCompletionEmail,
    sendOrderCompletionEmail,
    getDeliveryOrderCompletionEmailHtml,
    getBusinessOrderCompletionEmailHtml,
    dispatchBackgroundEmail,
    OTP_EXPIRY_MINUTES,
};


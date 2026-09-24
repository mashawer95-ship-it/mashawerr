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
 * Format any business monetary value (which is stored in whole integer Fils in the DB) to KD string with 3 decimals
 * e.g., 1000000 fils -> "1,000.000 د.ك"
 *       1000 fils    -> "1.000 د.ك"
 *       1899 fils    -> "1.899 د.ك"
 *       500 fils     -> "0.500 د.ك"
 *       0            -> "0.000 د.ك"
 */
const formatBusinessFilsToKD = (val, unit = 'د.ك') => {
    if (val == null || isNaN(val)) return `0.000 ${unit}`;
    let num = Number(val);
    if (num < 0) num = 0;

    // In the database, all business prices are stored in whole Fils.
    // Safeguard: if a value was already passed as small decimal KD (< 10 with non-zero fraction like 1.899), keep it as KD.
    let kd = (num < 10.0 && num !== Math.floor(num)) ? num : (num / 1000.0);

    const str = kd.toFixed(3);
    const parts = str.split('.');
    const intPart = parts[0].replace(/(\d{1,3})(?=(\d{3})+(?!\d))/g, '$1,');
    return `${intPart}.${parts[1]} ${unit}`;
};

/**
 * Build HTML Email Template for Business / Store Order Completion (RTL Senior Arabic Pure Black Design)
 * Brand Color: #C19418 (Golden Amber) | Pure Black Background (#000000) & Pure White Text (#ffffff)
 */
const getBusinessOrderCompletionEmailHtml = (order, client = {}) => {
    const appName = process.env.CLINIC_NAME || 'مشاوير | Mashawerr Business';
    const clientName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || order.userInfo?.firstName || 'عميلنا العزيز';
    const orderId = order.storeOrderId || order.orderId || order._id;

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

    let itemsCardsHtml = '';
    let calculatedItemsTotalFils = 0;

    const rawSubOrdersList = (Array.isArray(order.subOrders) && order.subOrders.length > 0)
        ? order.subOrders
        : [order];

    const subOrdersList = [...rawSubOrdersList].sort((a, b) => {
        const aIdx = a.subOrderIndex || 0;
        const bIdx = b.subOrderIndex || 0;
        if (aIdx !== bIdx && aIdx !== 0 && bIdx !== 0) return aIdx - bIdx;
        const aId = a.storeOrderId || a.taskId || 0;
        const bId = b.storeOrderId || b.taskId || 0;
        if (aId !== bId && aId !== 0 && bId !== 0) return aId - bId;
        const aTime = new Date(a.createdAt || 0).getTime();
        const bTime = new Date(b.createdAt || 0).getTime();
        return aTime - bTime;
    });

    // Check if subOrders have items or if items are on the root order
    const hasItemsInSubs = subOrdersList.some(s => Array.isArray(s.items) && s.items.length > 0);

    let totalItemsCount = 0;
    subOrdersList.forEach(sub => {
        if (Array.isArray(sub.items) && sub.items.length > 0) totalItemsCount += sub.items.length;
        else if (Array.isArray(order.items) && order.items.length > 0) totalItemsCount += order.items.length;
        else totalItemsCount += 1;
    });

    subOrdersList.forEach((sub, subIdx) => {
        let subItems = [];
        if (Array.isArray(sub.items) && sub.items.length > 0) {
            subItems = sub.items;
        } else if (!hasItemsInSubs && subIdx === 0 && Array.isArray(order.items) && order.items.length > 0) {
            subItems = order.items;
        }

        subItems = [...subItems].sort((a, b) => {
            const aIdx = a.itemIndex || 0;
            const bIdx = b.itemIndex || 0;
            if (aIdx !== bIdx && aIdx !== 0 && bIdx !== 0) return aIdx - bIdx;
            return 0;
        });

        const dropoffAddr = sub.deliveryLocation?.address || sub.deliveryLocation?.streetName || order.deliveryLocation?.address || order.deliveryLocation?.streetName || 'عنوان العميل (موقع التسليم)';
        const dropoffLat = sub.deliveryLocation?.latitude ?? sub.deliveryLocation?.lat ?? order.deliveryLocation?.latitude ?? order.deliveryLocation?.lat;
        const dropoffLng = sub.deliveryLocation?.longitude ?? sub.deliveryLocation?.lng ?? order.deliveryLocation?.longitude ?? order.deliveryLocation?.lng;
        const dropoffMapUrl = getGoogleMapsUrl(dropoffLat, dropoffLng, dropoffAddr);

        subItems.forEach((item, itemIdx) => {
            const imgUrl = resolveImageUrl(item.productImage || item.image || item.photo || item.productPhoto);
            const qty = item.quantity || 1;
            const itemPriceFils = item.price != null ? Number(item.price) : 0;
            let itemSubtotalFils = (item.subtotal != null && Number(item.subtotal) > 0)
                ? Number(item.subtotal)
                : (itemPriceFils * qty);

            calculatedItemsTotalFils += itemSubtotalFils;

            // Find matching task if order.tasks or order.orderTasks is available (matching Admin orderTasks)
            let matchingTask = null;
            if (Array.isArray(order.tasks) && order.tasks.length > 0) {
                matchingTask = order.tasks.find(t =>
                    (t.taskId && (Number(t.taskId) === itemIdx + 1 || String(t.taskId) === String(item.itemIndex))) ||
                    (t.deliveryDescription && item.name && t.deliveryDescription.includes(item.name))
                ) || order.tasks[itemIdx];
            } else if (Array.isArray(order.orderTasks) && order.orderTasks.length > 0) {
                matchingTask = order.orderTasks.find(t =>
                    (t.taskId && (Number(t.taskId) === itemIdx + 1 || String(t.taskId) === String(item.itemIndex))) ||
                    (t.deliveryDescription && item.name && t.deliveryDescription.includes(item.name))
                ) || order.orderTasks[itemIdx];
            }

            // Photos specifically for this product/task (matching Flutter Admin task cards)
            let itemPickupPhoto = resolveImageUrl(
                matchingTask?.itemPhotoBefore ||
                matchingTask?.ItemPhotoBefore ||
                matchingTask?.pickupPhoto ||
                matchingTask?.pickupPhotoUrl ||
                matchingTask?.photoBefore ||
                item.pickupPhoto ||
                item.pickupPhotoUrl ||
                item.itemPhotoBefore ||
                order.pickupPhotos?.[itemIdx] ||
                (totalItemsCount === 1 ? (sub.pickupPhoto || sub.pickupPhotoUrl || sub.itemPhotoBefore || order.pickupPhoto || order.pickupPhotoUrl || order.itemPhotoBefore || order.pickupPhotos?.[0]) : null)
            );

            let itemDeliveryPhoto = resolveImageUrl(
                matchingTask?.itemPhotoAfter ||
                matchingTask?.ItemPhotoAfter ||
                matchingTask?.deliveryPhoto ||
                matchingTask?.deliveryPhotoUrl ||
                matchingTask?.photoAfter ||
                matchingTask?.podPhoto ||
                matchingTask?.proofPhoto ||
                item.deliveryPhoto ||
                item.deliveryPhotoUrl ||
                item.itemPhotoAfter ||
                item.podPhoto ||
                item.proofPhoto ||
                order.deliveryPhotos?.[itemIdx] ||
                (totalItemsCount === 1 ? (sub.deliveryPhoto || sub.deliveryPhotoUrl || sub.itemPhotoAfter || sub.podPhoto || sub.proofPhoto || order.deliveryPhoto || order.deliveryPhotoUrl || order.itemPhotoAfter) : null)
            );

            itemsCardsHtml += `
            <div style="background-color: #000000; border: 1px solid #C19418; border-radius: 12px; padding: 16px; margin-bottom: 14px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                        <td style="width: 52px; vertical-align: middle;">
                            ${imgUrl ? `
                                <a href="${imgUrl}" target="_blank">
                                    <img src="${imgUrl}" alt="${item.name || 'منتج'}" style="width: 48px; height: 48px; object-fit: cover; border-radius: 8px; border: 1px solid #C19418; display: block;" />
                                </a>
                            ` : `
                                <div style="width: 48px; height: 48px; background-color: #000000; border-radius: 8px; border: 1px solid #C19418; text-align: center; line-height: 48px; font-size: 20px;">🛍️</div>
                            `}
                        </td>
                        <td style="padding: 0 12px; vertical-align: middle;">
                            <div style="font-weight: 700; color: #ffffff; font-size: 15px; line-height: 1.3;">${item.name || item.title || 'منتج'}</div>
                            <div style="font-size: 13px; color: #C19418; font-weight: 700; margin-top: 3px;">الكمية: x${qty}${qty > 1 ? ` (${formatBusinessFilsToKD(itemPriceFils)} للقطعة)` : ''}</div>
                        </td>
                        <td align="left" style="vertical-align: middle; white-space: nowrap;">
                            <div style="font-weight: 800; color: #ffffff; font-size: 15px;">${formatBusinessFilsToKD(itemSubtotalFils)}</div>
                        </td>
                    </tr>
                </table>

                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed #333333; font-size: 13px; color: #ffffff; line-height: 1.5;">
                    <span style="color: #60a5fa; font-weight: 700;">🔵 موقع التسليم:</span> ${dropoffAddr}
                    ${dropoffMapUrl ? `
                        <a href="${dropoffMapUrl}" target="_blank" style="display: inline-block; margin-right: 6px; background-color: #C19418; color: #ffffff; text-decoration: none; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; vertical-align: middle;">🗺️ فتح في الخريطة</a>
                    ` : ''}
                </div>

                ${(itemPickupPhoto || itemDeliveryPhoto) ? `
                <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed #C19418;">
                    <div style="font-size: 12px; font-weight: 700; color: #C19418; margin-bottom: 8px;">📷 صور الاستلام والتسليم الخاصة بهذا المنتج:</div>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            ${itemPickupPhoto ? `
                            <td align="center" style="width: 50%; padding-left: 6px;">
                                <div style="font-size: 11px; color: #C19418; margin-bottom: 4px; font-weight: 700;">صورة الاستلام (قبل)</div>
                                <a href="${itemPickupPhoto}" target="_blank">
                                    <img src="${itemPickupPhoto}" alt="صورة الاستلام" style="width: 100%; max-width: 180px; height: 115px; object-fit: cover; border-radius: 8px; border: 1.5px solid #C19418; display: block;" />
                                </a>
                            </td>
                            ` : ''}
                            ${itemDeliveryPhoto ? `
                            <td align="center" style="width: 50%; padding-right: 6px;">
                                <div style="font-size: 11px; color: #22c55e; margin-bottom: 4px; font-weight: 700;">صورة التسليم (بعد)</div>
                                <a href="${itemDeliveryPhoto}" target="_blank">
                                    <img src="${itemDeliveryPhoto}" alt="صورة التسليم" style="width: 100%; max-width: 180px; height: 115px; object-fit: cover; border-radius: 8px; border: 1.5px solid #22c55e; display: block;" />
                                </a>
                            </td>
                            ` : ''}
                        </tr>
                    </table>
                </div>
                ` : ''}
            </div>`;
        });
    });

    if (!itemsCardsHtml) {
        itemsCardsHtml = `<p style="color: #ffffff; font-size: 14px;">تم توصيل منتجات البيزنيس بنجاح.</p>`;
    }

    // ─── 💰 الفاتورة والملخص المالي: جلب الأسعار مباشرة من الداتا بيز (بالفلس) وتحويلها إلى د.ك ──
    // 1. إجمالي سعر المنتجات مباشرة من الداتا بيز (totalPrice)
    let dbProductsTotalFils = 0;
    if (Array.isArray(subOrdersList) && subOrdersList.length > 0) {
        dbProductsTotalFils = subOrdersList.reduce((sum, s) => sum + (Number(s.totalPrice) || 0), 0);
    }
    if (dbProductsTotalFils <= 0 && order.totalPrice != null) {
        dbProductsTotalFils = Number(order.totalPrice) || 0;
    }
    const finalProductsTotalFils = dbProductsTotalFils > 0 ? dbProductsTotalFils : calculatedItemsTotalFils;

    // 2. سعر التوصيل مباشرة من الداتا بيز (deliveryPrice / totalDeliveryPrice)
    let rawDeliveryFeeFils = 0;
    if (order.deliveryPrice != null && Number(order.deliveryPrice) > 0) {
        rawDeliveryFeeFils = Number(order.deliveryPrice);
    } else if (order.totalDeliveryPrice != null && Number(order.totalDeliveryPrice) > 0) {
        rawDeliveryFeeFils = Number(order.totalDeliveryPrice);
    }

    if (!rawDeliveryFeeFils && Array.isArray(subOrdersList)) {
        for (const sub of subOrdersList) {
            const d = (sub.deliveryPrice != null && Number(sub.deliveryPrice) > 0)
                ? Number(sub.deliveryPrice)
                : (Number(sub.totalDeliveryPrice) || 0);
            if (d > 0) {
                rawDeliveryFeeFils = d;
                break;
            }
        }
    }

    // 3. الإجمالي الكلي = إجمالي المنتجات + سعر التوصيل
    const grandTotalFils = finalProductsTotalFils + rawDeliveryFeeFils;

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>تفاصيل طلب بيزنيس - ${appName}</title>
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
              <p style="margin: 6px 0 0; color: #ffffff; font-size: 14px; font-weight: 600;">فاتورة وتفاصيل طلب البيزنيس المكتمل بالكامل</p>
            </td>
          </tr>

          <!-- Success Alert Header (No Emoji, Pure Black, Gold Border) -->
          <tr>
            <td style="padding: 24px 28px 12px;">
              <div style="background-color: #000000; border: 1px solid #C19418; border-radius: 12px; padding: 18px; text-align: center;">
                <h2 style="margin: 0 0 6px; color: #C19418; font-size: 20px; font-weight: 800;">تم توصيل طلبك بنجاح</h2>
                <p style="margin: 0; color: #ffffff; font-size: 14px; line-height: 1.5;">مرحبًا ${clientName}، اكتمل توصيل جميع منتجات الطلب بنجاح. إليك التفاصيل والفاتورة النهائية الموحدة:</p>
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

          <!-- Products & Quantities Breakdown -->
          <tr>
            <td style="padding: 0 28px 16px;">
              <h3 style="margin: 0 0 14px; color: #C19418; font-size: 16px; font-weight: 700; border-bottom: 2px solid #C19418; padding-bottom: 6px; display: inline-block;">🛍️ المنتجات المكتملة وصور الإثبات لكل منتج</h3>
              ${itemsCardsHtml}
            </td>
          </tr>

          <!-- Financial Invoice Summary -->
          <tr>
            <td style="padding: 0 28px 28px;">
              <h3 style="margin: 0 0 14px; color: #C19418; font-size: 16px; font-weight: 700; border-bottom: 2px solid #C19418; padding-bottom: 6px; display: inline-block;">💳 الفاتورة والملخص المالي النهائي</h3>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #000000; border: 1px solid #C19418; border-radius: 12px; padding: 18px; font-size: 14px; color: #ffffff;">
                <tr>
                  <td style="padding: 8px 0; color: #ffffff; font-weight: 700;">إجمالي سعر المنتجات:</td>
                  <td align="left" style="padding: 8px 0; color: #ffffff; font-weight: 600;">${formatBusinessFilsToKD(finalProductsTotalFils)}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #ffffff; font-weight: 700;">سعر التوصيل:</td>
                  <td align="left" style="padding: 8px 0; color: #ffffff; font-weight: 600;">${rawDeliveryFeeFils > 0 ? formatBusinessFilsToKD(rawDeliveryFeeFils) : '0.000 د.ك'}</td>
                </tr>
                <tr style="border-top: 1px dashed #C19418;">
                  <td style="padding: 14px 0 4px; font-weight: 700; color: #ffffff; font-size: 16px;">الإجمالي المدفوع:</td>
                  <td align="left" style="padding: 14px 0 4px; font-weight: 800; color: #C19418; font-size: 20px;">${formatBusinessFilsToKD(grandTotalFils)}</td>
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

/**
 * Send business store order completion email to client automatically
 * @param {object|string|number} orderIdOrDoc - Order document or Order ID
 */
const sendBusinessOrderCompletionEmail = async (orderIdOrDoc) => {
    const { StoreOrder } = require('../middlewares/StoreOrder');
    const { User } = require('../middlewares/User');
    const mongoose = require('mongoose');

    let order = null;

    // ─── STEP 1: RESOLVE BUSINESS GROUP ───────────────────────────────────────
    const rawId = (typeof orderIdOrDoc === 'object' && orderIdOrDoc !== null)
        ? (orderIdOrDoc.parentGroupId || orderIdOrDoc.orderId || orderIdOrDoc.storeOrderId || orderIdOrDoc._id)
        : orderIdOrDoc;

    const isUUID = rawId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(rawId));

    if (isUUID) {
        const subs = await StoreOrder.find({ parentGroupId: String(rawId) }).lean();
        if (!subs || subs.length === 0) {
            console.warn('[EmailService] ⚠️ No store orders found for parentGroupId:', rawId);
            return { success: false, reason: 'order_not_found' };
        }
        order = {
            ...subs[0],
            parentGroupId: String(rawId),
            subOrders: subs,
            isBusinessOrder: true,
        };
    } else if (rawId) {
        const numId = !isNaN(Number(rawId)) ? Number(rawId) : -1;
        const isValidObjId = mongoose.isValidObjectId(rawId);

        const storeMatches = await StoreOrder.find({
            $and: [
                {
                    $or: [
                        { isBusinessOrder: true },
                        { orderCategory: 'business' },
                        { parentGroupId: { $ne: null } },
                        { items: { $exists: true, $not: { $size: 0 } } }
                    ]
                },
                {
                    $or: [
                        ...(numId > 0 ? [{ storeOrderId: numId }, { orderId: numId }] : []),
                        ...(isValidObjId ? [{ _id: rawId }] : [])
                    ]
                }
            ]
        }).lean();

        if (storeMatches.length > 0) {
            const parentGroupId = storeMatches[0].parentGroupId;
            if (parentGroupId) {
                const allSubs = await StoreOrder.find({ parentGroupId }).lean();
                order = {
                    ...storeMatches[0],
                    parentGroupId,
                    subOrders: allSubs,
                    isBusinessOrder: true,
                };
            } else if (storeMatches[0].storeOrderId) {
                const allSubs = await StoreOrder.find({ storeOrderId: storeMatches[0].storeOrderId }).lean();
                order = {
                    ...storeMatches[0],
                    subOrders: allSubs,
                    isBusinessOrder: true,
                };
            } else {
                order = {
                    ...storeMatches[0],
                    subOrders: [storeMatches[0]],
                    isBusinessOrder: true,
                };
            }
        }
    } else if (typeof orderIdOrDoc === 'object' && orderIdOrDoc !== null) {
        order = orderIdOrDoc;
    }

    if (!order || typeof order !== 'object') {
        console.warn('[EmailService] ⚠️ Business order completion email skipped: Order doc not found for input:', orderIdOrDoc);
        return { success: false, reason: 'order_not_found' };
    }

    // ─── STEP 2: AUTHORITATIVE GATE CHECK FOR BUSINESS ORDERS ────────────────
    const queryFilter = order.parentGroupId
        ? { parentGroupId: order.parentGroupId }
        : (order.storeOrderId ? { storeOrderId: order.storeOrderId } : { _id: order._id });

    const currentSubs = await StoreOrder.find(queryFilter).lean();

    if (!currentSubs || currentSubs.length === 0) {
        console.warn('[EmailService] ⚠️ Gate check failed: No sub-orders found in DB for filter:', queryFilter);
        return { success: false, reason: 'order_not_found' };
    }

    const alreadySent = currentSubs.some(s => s.hasCompletionEmailSent === true);
    if (alreadySent) {
        console.log(`[EmailService] ℹ️ Completion email already sent for business order group (${JSON.stringify(queryFilter)}). Skipping.`);
        return { success: true, reason: 'already_sent' };
    }

    const DELIVERED_STATUSES = ['delivered', 'completed', 'done'];

    // Strict Gate Check: Hold email if ANY sub-order or ANY item is not finished
    const hasUnfinishedSub = currentSubs.some(s => {
        const isSubDone = DELIVERED_STATUSES.includes(String(s.status).toLowerCase());
        if (!isSubDone) return true;
        if (Array.isArray(s.items) && s.items.length > 0) {
            const itemsDone = s.items.every(i => i.isDelivered === true || DELIVERED_STATUSES.includes(String(i.status || s.status).toLowerCase()));
            if (!itemsDone) return true;
        }
        return false;
    });

    if (hasUnfinishedSub) {
        const pendingSummary = currentSubs.map(s => `${s._id}:${s.status}`).join(', ');
        console.log(`[EmailService] ⏳ Hold email: Order group (${JSON.stringify(queryFilter)}) has pending sub-orders or items (${pendingSummary}). Holding email until full order completion.`);
        return { success: false, reason: 'sub_orders_pending' };
    }

    const markResult = await StoreOrder.updateMany(
        {
            ...queryFilter,
            hasCompletionEmailSent: { $ne: true }
        },
        { $set: { hasCompletionEmailSent: true } }
    );

    if (markResult.modifiedCount === 0) {
        console.log(`[EmailService] ℹ️ Atomic lock: Concurrent process already claimed email send for business group (${JSON.stringify(queryFilter)}). Skipping.`);
        return { success: true, reason: 'already_sent' };
    }

    order.subOrders = currentSubs;

    // ─── STEP 3: RESOLVE CLIENT EMAIL ─────────────────────────────────────────
    const clientId = order.userId || order.clientId || order.user;
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
        console.warn(`[EmailService] ⚠️ Business Order #${order.storeOrderId || order.orderId} has no client email attached (ClientId: ${clientId}). Email skipped.`);
        return { success: false, reason: 'no_client_email' };
    }

    // ─── STEP 3.5: RESOLVE POD PROOF PHOTOS FOR EACH SUB-ORDER & ITEM ───────────────
    try {
        const { enrichOrder } = require('../Controllers/storeOrderController');
        const enriched = await enrichOrder(null, order);
        if (enriched) {
            order = enriched;
        }
    } catch (err) {
        console.warn('[EmailService] Warning enriching business order with enrichOrder:', err.message);
    }

    try {
        const { DeliverySession } = require('../models/DeliverySession');
        const { DeliveryAttempt } = require('../models/DeliveryAttempt');

        const allSubsList = (order.subOrders || currentSubs || []);
        const allOrderIds = [
            order._id,
            order._id ? order._id.toString() : null,
            order.storeOrderId,
            order.storeOrderId ? String(order.storeOrderId) : null,
            !isNaN(Number(order.storeOrderId)) ? Number(order.storeOrderId) : null,
            order.orderId,
            order.orderId ? String(order.orderId) : null,
            !isNaN(Number(order.orderId)) ? Number(order.orderId) : null,
            order.parentGroupId,
            order.activeDeliverySessionId,
            order.deliverySessionId,
            ...allSubsList.flatMap(s => [
                s._id,
                s._id ? s._id.toString() : null,
                s.storeOrderId,
                s.storeOrderId ? String(s.storeOrderId) : null,
                !isNaN(Number(s.storeOrderId)) ? Number(s.storeOrderId) : null,
                s.orderId,
                s.orderId ? String(s.orderId) : null,
                !isNaN(Number(s.orderId)) ? Number(s.orderId) : null,
                s.activeDeliverySessionId,
                s.deliverySessionId
            ])
        ].filter(Boolean);

        const allOrderSessions = await DeliverySession.find({
            $or: [
                { orderId: { $in: allOrderIds } },
                { sessionId: { $in: allOrderIds } }
            ]
        }).lean();

        const allSessionIds = [
            ...allOrderSessions.map(s => s.sessionId),
            order.activeDeliverySessionId,
            order.deliverySessionId,
            ...allSubsList.map(s => s.activeDeliverySessionId || s.deliverySessionId)
        ].filter(Boolean);

        const sessionAttempts = await DeliveryAttempt.find({
            $or: [
                { sessionId: { $in: allSessionIds } },
                { orderId: { $in: allOrderIds } }
            ]
        }).sort({ createdAt: 1, attemptNumber: 1 }).lean();

        const pickupAttempts = sessionAttempts.filter(a => a.phase === 'PICKUP' || a.phase === 'pickup');
        const deliveryAttempts = sessionAttempts.filter(a => a.phase === 'DELIVERY' || a.phase === 'delivery');

        let globalItemCounter = 0;
        for (const sub of allSubsList) {
            if (Array.isArray(sub.items) && sub.items.length > 0) {
                const isSingleOverallItem = sub.items.length === 1 && allSubsList.length === 1;

                for (let i = 0; i < sub.items.length; i++) {
                    const item = sub.items[i];
                    const itemGlobalIdx = globalItemCounter++;
                    const prodIdStr = String(item.product || item._id || '');
                    const itemIdx = item.itemIndex != null ? Number(item.itemIndex) : (i + 1);

                    // 1. Delivery Photo
                    if (deliveryAttempts.length > 1 && deliveryAttempts[itemGlobalIdx]) {
                        const p = deliveryAttempts[itemGlobalIdx].photo;
                        const photoUrl = p ? (p.cdnUrl || p.url || p.secure_url || (p.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${p.objectKey}` : null)) : null;
                        if (photoUrl) {
                            item.deliveryPhoto = photoUrl;
                            item.itemPhotoAfter = photoUrl;
                            item.deliveryPhotoUrl = photoUrl;
                        }
                    } else if (!item.deliveryPhoto && !item.itemPhotoAfter && !item.deliveryPhotoUrl) {
                        let itemDAttempt = sessionAttempts.find(a =>
                            (a.phase === 'DELIVERY' || a.phase === 'delivery') &&
                            (
                                (a.productId && String(a.productId) === prodIdStr) ||
                                (a.itemIndex != null && Number(a.itemIndex) === itemIdx) ||
                                (a.taskId && (String(a.taskId) === String(itemIdx) || String(a.taskId) === String(sub.subOrderIndex)))
                            )
                        );
                        if (!itemDAttempt && deliveryAttempts[itemGlobalIdx]) {
                            itemDAttempt = deliveryAttempts[itemGlobalIdx];
                        }
                        if (itemDAttempt && itemDAttempt.photo) {
                            const p = itemDAttempt.photo;
                            const photoUrl = p.cdnUrl || p.url || p.secure_url || (p.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${p.objectKey}` : null);
                            if (photoUrl) {
                                item.deliveryPhoto = photoUrl;
                                item.itemPhotoAfter = photoUrl;
                            }
                        } else if (isSingleOverallItem && (sub.deliveryPhoto || sub.itemPhotoAfter || sub.deliveryPhotoUrl)) {
                            item.deliveryPhoto = sub.deliveryPhoto || sub.itemPhotoAfter || sub.deliveryPhotoUrl;
                            item.itemPhotoAfter = item.deliveryPhoto;
                        }
                    }

                    // 2. Pickup Photo
                    if (pickupAttempts.length > 1 && pickupAttempts[itemGlobalIdx]) {
                        const p = pickupAttempts[itemGlobalIdx].photo;
                        const photoUrl = p ? (p.cdnUrl || p.url || p.secure_url || (p.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${p.objectKey}` : null)) : null;
                        if (photoUrl) {
                            item.pickupPhoto = photoUrl;
                            item.itemPhotoBefore = photoUrl;
                            item.pickupPhotoUrl = photoUrl;
                        }
                    } else if (!item.pickupPhoto && !item.itemPhotoBefore && !item.pickupPhotoUrl) {
                        let itemPAttempt = sessionAttempts.find(a =>
                            (a.phase === 'PICKUP' || a.phase === 'pickup') &&
                            (
                                (a.productId && String(a.productId) === prodIdStr) ||
                                (a.itemIndex != null && Number(a.itemIndex) === itemIdx) ||
                                (a.taskId && (String(a.taskId) === String(itemIdx) || String(a.taskId) === String(sub.subOrderIndex)))
                            )
                        );
                        if (!itemPAttempt && pickupAttempts[itemGlobalIdx]) {
                            itemPAttempt = pickupAttempts[itemGlobalIdx];
                        }
                        if (itemPAttempt && itemPAttempt.photo) {
                            const p = itemPAttempt.photo;
                            const photoUrl = p.cdnUrl || p.url || p.secure_url || (p.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${p.objectKey}` : null);
                            if (photoUrl) {
                                item.pickupPhoto = photoUrl;
                                item.itemPhotoBefore = photoUrl;
                            }
                        } else if (isSingleOverallItem && (sub.pickupPhoto || sub.itemPhotoBefore || sub.pickupPhotoUrl || order.pickupPhoto)) {
                            item.pickupPhoto = sub.pickupPhoto || sub.itemPhotoBefore || sub.pickupPhotoUrl || order.pickupPhoto;
                            item.itemPhotoBefore = item.pickupPhoto;
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[EmailService] Warning resolving sub-order delivery session photos:', err.message);
    }

    // ─── STEP 4: BUILD HTML & DISPATCH ─────────────────────────────────────────
    try {
        const subject = `🛍️ تفاصيل وفاتورة طلب البيزنيس المكتمل #${order.storeOrderId || order.orderId}`;
        const html = getBusinessOrderCompletionEmailHtml(order, client || {});

        console.log(`[EmailService] ✉️ Dispatching business order completion email to ${recipientEmail} for Order #${order.storeOrderId || order.orderId}...`);

        return await sendEmail({
            to: recipientEmail,
            subject,
            html,
        });
    } catch (err) {
        console.error('[EmailService] ❌ Failed to send business order completion email:', err.message);
        throw err;
    }
};

/**
 * Backward-compatibility wrapper for sending order completion emails (Routes to Delivery or Business)
 * @param {object|string|number} orderIdOrDoc - Order document or Order ID
 */
const sendOrderCompletionEmail = async (orderIdOrDoc) => {
    let isBusiness = false;

    if (typeof orderIdOrDoc === 'object' && orderIdOrDoc !== null) {
        isBusiness = orderIdOrDoc.isBusinessOrder === true ||
            orderIdOrDoc.orderCategory === 'business' ||
            !!orderIdOrDoc.parentGroupId ||
            !!orderIdOrDoc.storeOrderId ||
            (Array.isArray(orderIdOrDoc.items) && orderIdOrDoc.items.length > 0);
    } else if (orderIdOrDoc) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(orderIdOrDoc));
        if (isUUID) {
            isBusiness = true;
        } else {
            const { StoreOrder } = require('../middlewares/StoreOrder');
            const mongoose = require('mongoose');
            const numId = !isNaN(Number(orderIdOrDoc)) ? Number(orderIdOrDoc) : -1;
            const isValidObjId = mongoose.isValidObjectId(orderIdOrDoc);

            const storeMatch = await StoreOrder.findOne({
                $and: [
                    {
                        $or: [
                            { isBusinessOrder: true },
                            { orderCategory: 'business' },
                            { parentGroupId: { $ne: null } },
                            { items: { $exists: true, $not: { $size: 0 } } }
                        ]
                    },
                    {
                        $or: [
                            ...(numId > 0 ? [{ storeOrderId: numId }, { orderId: numId }] : []),
                            ...(isValidObjId ? [{ _id: orderIdOrDoc }] : [])
                        ]
                    }
                ]
            }).select('_id').lean();

            if (storeMatch) {
                isBusiness = true;
            }
        }
    }

    if (isBusiness) {
        return await sendBusinessOrderCompletionEmail(orderIdOrDoc);
    } else {
        return await sendDeliveryOrderCompletionEmail(orderIdOrDoc);
    }
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


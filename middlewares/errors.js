/**
 * middlewares/errors.js
 * Centralized Enterprise Error Handling Middleware for Mashawerr API.
 *
 * Designed for high-scale applications (millions of users):
 * - Sanitizes internal server / uncaught errors (500) so technical stack traces and system exceptions are NEVER leaked to mobile clients.
 * - Formats friendly, localized Arabic/English error messages for end users.
 * - Detects and categorizes Mongoose, JWT, Multer, JSON syntax, and Network/Service connection errors into proper HTTP status codes.
 * - Preserves business/operational errors (400, 401, 403, 404, 409, 422, 429) for client feedback.
 * - Logs complete internal metadata (stack trace, request ID, user ID, method, body, URL) into Winston logger.
 */

const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const notFound = (req, res, next) => {
    const error = ApiError.notFound(`المسار المطلوب غير موجود - ${req.originalUrl}`);
    next(error);
};

const MONGO_CONNECTION_ERRORS = [
    'MongooseServerSelectionError',
    'MongoServerSelectionError',
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoParseError',
];

const errorHandler = (err, req, res, next) => {
    let error = err;

    // 1. Convert non-ApiError instances or raw system exceptions into standard ApiError classification
    if (!(error instanceof ApiError)) {
        let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : (error.statusCode || 500);
        let message = error.message || 'حدث خطأ في النظام';
        let code = null;
        let details = null;
        let isOperational = false;

        // A. File Upload (Multer) Errors
        if (error.code === 'LIMIT_FILE_SIZE') {
            statusCode = 400;
            code = 'FILE_TOO_LARGE';
            message = 'حجم الملف كبير جداً. الحد الأقصى المسموح به هو 5 ميجابايت.';
            isOperational = true;
        } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            statusCode = 400;
            code = 'UNEXPECTED_FILE_FIELD';
            message = 'حقل رفع الملف غير متوقع. يرجى التأكد من اسم الحقل المطلوب.';
            isOperational = true;
        } else if (error.message && error.message.startsWith('Invalid file type.')) {
            statusCode = 400;
            code = 'INVALID_FILE_TYPE';
            message = 'نوع الملف المرفق غير مدعوم.';
            isOperational = true;
        }

        // B. MongoDB / Mongoose Errors
        else if (error.name === 'CastError') {
            statusCode = 400;
            code = 'INVALID_ID';
            message = `القيمة المدخلة غير صالحة (${error.path}).`;
            isOperational = true;
        } else if (error.name === 'ValidationError') {
            statusCode = 400;
            code = 'VALIDATION_ERROR';
            const errorsList = Object.values(error.errors || {}).map(e => e.message);
            message = errorsList.length > 0 ? errorsList.join('; ') : 'البيانات المدخلة غير صالحة.';
            details = error.errors;
            isOperational = true;
        } else if (error.code === 11000) {
            statusCode = 409;
            code = 'DUPLICATE_RESOURCE';
            const keys = Object.keys(error.keyValue || {});
            const keyStr = keys.length > 0 ? ` (${keys.join(', ')})` : '';
            message = `هذا السجل موجود بالفعل في النظام${keyStr}.`;
            isOperational = true;
        } else if (
            MONGO_CONNECTION_ERRORS.includes(error.name) ||
            error.message?.toLowerCase().includes('buffering timed out') ||
            error.message?.toLowerCase().includes('server selection timed out') ||
            error.message?.toLowerCase().includes('topology was destroyed')
        ) {
            statusCode = 503;
            code = 'DATABASE_UNAVAILABLE';
            message = 'تعذر الاتصال بقاعدة البيانات حالياً، يرجى المحاولة بعد قليل.';
            isOperational = true;
        }

        // C. JWT Authentication Errors
        else if (error.name === 'JsonWebTokenError') {
            statusCode = 401;
            code = 'INVALID_TOKEN';
            message = 'رمز التوثيق غير صالح، يرجى إعادة تسجيل الدخول.';
            isOperational = true;
        } else if (error.name === 'TokenExpiredError') {
            statusCode = 401;
            code = 'TOKEN_EXPIRED';
            message = 'انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول.';
            isOperational = true;
        }

        // D. Network & Connectivity / External Service Errors (Axios, Fetch, Sockets, Service Timeouts)
        else if (
            error.code === 'ECONNREFUSED' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'ENOTFOUND' ||
            error.code === 'ECONNABORTED' ||
            error.code === 'ECONNRESET' ||
            error.code === 'EHOSTUNREACH' ||
            error.code === 'ENETUNREACH' ||
            error.code === 'EPIPE' ||
            error.code === 'ERR_NETWORK' ||
            error.code === 'ERR_BAD_RESPONSE' ||
            error.message === 'Redis is unavailable'
        ) {
            statusCode = 503;
            code = 'SERVICE_CONNECTIVITY_ERROR';
            message = 'تعذر الاتصال بالشبكة أو الخدمات الخارجية، يرجى التحقق من اتصال الإنترنت والمحاولة لاحقاً.';
            isOperational = true;
        }

        // E. JSON Syntax / Body Parser Error
        else if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
            statusCode = 400;
            code = 'INVALID_JSON_PAYLOAD';
            message = 'تنسيق البيانات المبعوثة (JSON) غير صحيح.';
            isOperational = true;
        }

        error = new ApiError(statusCode, message, code, details, isOperational);
        error.stack = err.stack; // Preserve original stack trace for logging
    }

    // 2. Determine final status code and response message for the client
    const statusCode = error.statusCode || 500;
    const isDev = process.env.NODE_ENV === 'development';
    const requestId = req.id || req.headers['x-request-id'] || 'N/A';

    // Client facing message:
    // If it's a 500 server error or non-operational bug in production, show clean, elegant Arabic user message
    let clientMessage = error.message;
    if (statusCode >= 500 && !error.isOperational && !isDev) {
        clientMessage = 'حدث خطأ غير متوقع في التطبيق، والفريق يقوم بالتصليح فوراً';
    }

    // 3. Structured internal logging (Winston) - Full technical trace logged internally
    logger.error(`[API_ERROR] ${req.method} ${req.originalUrl}`, {
        requestId,
        statusCode,
        code: error.code,
        message: err.message || error.message,
        isOperational: error.isOperational,
        stack: err.stack || error.stack,
        userId: req.user?.id || req.user?._id || 'N/A',
        userRole: req.user?.role || 'N/A',
        ip: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    });

    // 4. Send standardized client response (100% backward compatible with existing mobile apps)
    res.status(statusCode).json({
        success: false,
        message: clientMessage,
        code: error.code || ApiError.getCodeFromStatus(statusCode),
        requestId: requestId !== 'N/A' ? requestId : undefined,
        ...(error.details && { details: error.details }),
        ...(isDev && { error: err.message, stack: err.stack }),
    });
};

module.exports = { notFound, errorHandler };

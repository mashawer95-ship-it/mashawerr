/**
 * ApiError.js
 * Custom Operational Error class for enterprise error handling.
 * Differentiates trusted operational errors from programming bugs.
 */

class ApiError extends Error {
    constructor(statusCode, message, code = null, details = null, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.code = code || ApiError.getCodeFromStatus(statusCode);
        this.details = details;
        this.isOperational = isOperational;

        Error.captureStackTrace(this, this.constructor);
    }

    static getCodeFromStatus(statusCode) {
        switch (statusCode) {
            case 400: return 'BAD_REQUEST';
            case 401: return 'UNAUTHORIZED';
            case 403: return 'FORBIDDEN';
            case 404: return 'NOT_FOUND';
            case 409: return 'CONFLICT';
            case 422: return 'VALIDATION_ERROR';
            case 429: return 'TOO_MANY_REQUESTS';
            case 503: return 'SERVICE_UNAVAILABLE';
            case 504: return 'GATEWAY_TIMEOUT';
            default: return 'INTERNAL_SERVER_ERROR';
        }
    }

    static badRequest(message = 'طلب غير صالح - Bad Request', code = 'BAD_REQUEST', details = null) {
        return new ApiError(400, message, code, details, true);
    }

    static unauthorized(message = 'غير مصرح بالدخول - Unauthorized', code = 'UNAUTHORIZED', details = null) {
        return new ApiError(401, message, code, details, true);
    }

    static forbidden(message = 'غير مسموح بالوصول لهذا المورد - Forbidden', code = 'FORBIDDEN', details = null) {
        return new ApiError(403, message, code, details, true);
    }

    static notFound(message = 'المورد المطلوب غير موجود - Not Found', code = 'NOT_FOUND', details = null) {
        return new ApiError(404, message, code, details, true);
    }

    static conflict(message = 'تعارض في البيانات - Conflict', code = 'CONFLICT', details = null) {
        return new ApiError(409, message, code, details, true);
    }

    static unprocessable(message = 'بيانات غير صالحة للمعالجة - Validation Error', code = 'VALIDATION_ERROR', details = null) {
        return new ApiError(422, message, code, details, true);
    }

    static tooManyRequests(message = 'تم تجاوز عدد المحاولات المسموح بها، يرجى الانتظار والمحاولة لاحقاً', code = 'TOO_MANY_REQUESTS', details = null) {
        return new ApiError(429, message, code, details, true);
    }

    static internal(message = 'حدث خطأ غير متوقع في التطبيق، والفريق يقوم بالتصليح فوراً', code = 'INTERNAL_SERVER_ERROR', details = null) {
        return new ApiError(500, message, code, details, false);
    }

    static serviceUnavailable(message = 'الخدمة غير متاحة حالياً، يرجى المحاولة بعد قليل', code = 'SERVICE_UNAVAILABLE', details = null) {
        return new ApiError(503, message, code, details, true);
    }
}

module.exports = ApiError;

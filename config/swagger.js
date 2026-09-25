/**
 * Swagger (OpenAPI 3.0) configuration for Mashawerr API
 * Uses swagger-jsdoc to build the spec; serve with swagger-ui-express at /api-docs
 *
 * Server URL priority:
 *   1. process.env.HOST  – set this on production (e.g. https://mashawerr.onrender.com)
 *   2. http://localhost:3000  – automatic fallback for local development
 */

const swaggerJsdoc = require('swagger-jsdoc');

const HOST = process.env.HOST || `http://localhost:${process.env.PORT || 3000}`;
const isProduction = !!process.env.HOST;

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Mashawerr API',
            version: '1.0.0',
            description: 'REST API for Mashawerr application with JWT authentication and user management.',
        },
        servers: [
            {
                url: HOST,
                description: isProduction ? 'Production server' : 'Local development server',
            },
            ...(isProduction
                ? [{ url: `http://localhost:${process.env.PORT || 3000}`, description: 'Local development server' }]
                : [{ url: 'https://mashawerr.onrender.com', description: 'Production server (Render)' }]
            ),
        ],
        tags: [
            { name: 'Auth', description: 'Authentication and email verification' },
            { name: 'Users', description: 'User management (protected)' },
            { name: 'Pricing', description: 'Admin JWT required (isAdmin: true) for ALL endpoints. Amounts in fils.' },
            { name: 'Orders', description: 'Order management – create and retrieve orders' },
            { name: 'Discounts', description: 'Discount system (fils).' },
            { name: 'Notifications', description: 'Firebase Cloud Messaging (FCM) push notifications.' },
            { name: 'Ride Tracking', description: 'Route Tracking via Google Routes API.' },
            { name: 'Live Driver Tracking', description: 'Realtime GPS Tracking.' },
            { name: 'Chat', description: 'Real-time chat between Client and Representative.' },
            { name: 'User Ratings', description: 'Mutual rating system.' },
            { name: 'Vehicle Types', description: 'Vehicle types management.' },
        ],
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'Enter your JWT token from login or verify-email',
                },
            },
            schemas: {
                
                VehicleType: {
                    type: 'object',
                    properties: {
                        _id: { type: 'string' },
                        name_ar: { type: 'string' },
                        name_en: { type: 'string' },
                        image: { type: 'string' },
                        baseFare: { type: 'number', description: 'Base fare in fils' },
                        baseFare_name_ar: { type: 'string' },
                        pricePerMeter: { type: 'number', description: 'Price per meter in fils' },
                        pricePerMeter_name_ar: { type: 'string' },
                        minFare: { type: 'number', description: 'Minimum fare in fils' },
                        minFare_name_ar: { type: 'string' },
                        isActive: { type: 'boolean' },
                    }
                },
                RoleRequest: {
                    type: 'object',
                    properties: {
                        _id: { type: 'string' },
                        user: { type: 'string', description: 'User ID or populated User object' },
                        requestedRole: { type: 'string', enum: ['Representative'] },
                        description: { type: 'string' },
                        phone: { type: 'string' },
                        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                    }
                },
                CreateRoleRequest: {
                    type: 'object',
                    required: ['requestedRole', 'description', 'phone'],
                    properties: {
                        requestedRole: { type: 'string', enum: ['Representative'], example: 'Representative' },
                        description: { type: 'string', example: 'عايز ابقي مندوب معكم' },
                        phone: { type: 'string', example: '01012345678' }
                    }
                },
                UpdateRoleRequestStatus: {
                    type: 'object',
                    required: ['status'],
                    properties: {
                        status: { type: 'string', enum: ['approved', 'rejected'], example: 'approved' }
                    }
                },
                RegisterRequest: {
                    required: ['firstName', 'lastName', 'email', 'phone', 'password', 'confirmPassword'],
                    properties: {
                        firstName: { type: 'string', example: 'Ahmed', minLength: 2, maxLength: 100 },
                        lastName: { type: 'string', example: 'Mohamed', minLength: 2, maxLength: 100 },
                        email: { type: 'string', format: 'email', example: 'user@example.com', minLength: 5, maxLength: 100 },
                        phone: { type: 'string', example: '01012345678', minLength: 7, maxLength: 15 },
                        password: { type: 'string', format: 'password', minLength: 6, example: 'Password123' },
                        confirmPassword: { type: 'string', format: 'password', minLength: 6, example: 'Password123', description: 'Must match password' },
                    },
                },
                LoginRequest: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string', format: 'email', example: 'user@example.com' },
                        password: { type: 'string', format: 'password', example: 'YourPassword123' },
                    },
                },
                VerifyEmailRequest: {
                    type: 'object',
                    required: ['email', 'code'],
                    properties: {
                        email: { type: 'string', format: 'email', example: 'user@example.com' },
                        code: { type: 'string', example: '123456', minLength: 6, maxLength: 6, description: '6-digit OTP' },
                    },
                },
                ResendOtpRequest: {
                    type: 'object',
                    required: ['email'],
                    properties: {
                        email: { type: 'string', format: 'email', example: 'user@example.com' },
                    },
                },
                ChangePasswordRequest: {
                    type: 'object',
                    required: ['userId', 'oldPassword', 'newPassword'],
                    properties: {
                        userId: { type: 'string', description: 'User account _id (24-char hex)', example: '507f1f77bcf86cd799439011' },
                        oldPassword: { type: 'string', format: 'password', description: 'Current password' },
                        newPassword: { type: 'string', format: 'password', minLength: 1, description: 'New password (any)' },
                    },
                },
                ForgotPasswordRequest: {
                    type: 'object',
                    required: ['email'],
                    properties: {
                        email: { type: 'string', format: 'email', example: 'user@example.com' },
                    },
                },
                VerifyResetCodeRequest: {
                    type: 'object',
                    required: ['email', 'code'],
                    properties: {
                        email: { type: 'string', format: 'email', example: 'user@example.com' },
                        code: { type: 'string', example: '123456', minLength: 6, maxLength: 6, description: '6-digit OTP from forgot-password email' },
                    },
                },
                ResetPasswordRequest: {
                    type: 'object',
                    required: ['resetToken', 'newPassword', 'confirmPassword'],
                    properties: {
                        resetToken: { type: 'string', description: 'Short-lived JWT token returned from verify-reset-code' },
                        newPassword: { type: 'string', format: 'password', minLength: 6, description: 'New password (min 6 chars)' },
                        confirmPassword: { type: 'string', format: 'password', minLength: 6, description: 'Must match newPassword' },
                    },
                },
                UserUpdateRequest: {
                    type: 'object',
                    properties: {
                        firstName: { type: 'string', minLength: 2, maxLength: 100 },
                        lastName: { type: 'string', minLength: 2, maxLength: 100 },
                        phone: { type: 'string', minLength: 7, maxLength: 15 },
                    },
                },
                User: {
                    type: 'object',
                    properties: {
                        _id: { type: 'string', example: '507f1f77bcf86cd799439011' },
                        firstName: { type: 'string', example: 'Ahmed' },
                        lastName: { type: 'string', example: 'Mohamed' },
                        email: { type: 'string', format: 'email' },
                        phone: { type: 'string', example: '01012345678' },
                        isAdmin: { type: 'boolean', default: false },
                        userType: {
                            type: 'string',
                            example: 'NormalUser',
                            default: 'NormalUser',
                            description: 'Account type; default NormalUser. Change per user in MongoDB only (not via public register).',
                        },
                        isVerified: { type: 'boolean' },
                        isSuspended: { type: 'boolean', default: false, description: 'إذا كانت true، الحساب موقوف ولا يمكن تسجيل الدخول' },
                        canEditVehicleInfo: { type: 'boolean', default: false, description: 'إذا كانت true، يمكن للمندوب تعديل بيانات المركبة حتى لو كانت مكتملة' },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                    },
                },
                Profile: {
                    type: 'object',
                    properties: {
                        firstName: { type: 'string', example: 'Ahmed' },
                        lastName: { type: 'string', example: 'Mohamed' },
                        email: { type: 'string', format: 'email' },
                        phone: { type: 'string', example: '01012345678' },
                        profileImage: { type: 'string', nullable: true, description: 'Full URL of profile image' },
                        canEditVehicleInfo: { type: 'boolean', default: false, description: 'إمكانية تعديل بيانات المركبة للمندوب' },
                    },
                },
                UserWithToken: {
                    allOf: [
                        { $ref: '#/components/schemas/User' },
                        {
                            type: 'object',
                            properties: {
                                token: { type: 'string', description: 'JWT for Authorization header' },
                            },
                        },
                    ],
                },
                MessageResponse: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                    },
                },
                RegisterResponse: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', example: 'Registration successful. Please check your email to verify your account.' },
                        email: { type: 'string', format: 'email' },
                        userType: { type: 'string', example: 'NormalUser', description: 'Default NormalUser; change per account in MongoDB — value at login reflects DB' },
                    },
                },
                PricingConfig: {
                    type: 'object',
                    properties: {
                        baseFare: { type: 'number', example: 0, description: 'Fils only — fixed fee per trip (decimals OK, e.g. 0.5 fils)' },
                        baseFare_name_ar: { type: 'string', example: '0 د.ك', description: 'Human-readable (Arabic); numeric fields above are fils' },
                        pricePerMeter: { type: 'number', example: 1, description: '**فلس لكل متر.** مثال: 1 = 1 فلس/متر | 2 = 2 فلس/متر | 0.5 = نص فلس/متر' },
                        pricePerMeter_name_ar: { type: 'string', example: 'سعر المتر: 1 فلس (0.001 د.ك)', description: 'Display only — سعر المتر الواحد بالفلس' },
                        minFare: { type: 'number', example: 0, description: 'Fils only — stored; **not used** in calculate-price' },
                        minFare_name_ar: { type: 'string', example: '0 د.ك', description: 'Display only' },
                        surgeMultiplier: { type: 'number', example: 1, description: 'Surge multiplier (1 = no surge)' },
                        updatedAt: { type: 'string', format: 'date-time', description: 'Last update timestamp' },
                    },
                },
                CalculatePriceRequest: {
                    type: 'object',
                    required: ['distance_meters'],
                    properties: {
                        distance_meters: { type: 'number', minimum: 0, example: 5000, description: 'Trip distance in meters (e.g. 5000 m at 1 fil/m = 5000 fils = 5 KD)' },
                    },
                },
                CalculatePriceResponse: {
                    type: 'object',
                    properties: {
                        distance_meters: { type: 'number', example: 5000 },
                        price: { type: 'number', example: 5000, description: 'Final fare in fils (may be fractional if per-meter rate is fractional)' },
                        name_ar: { type: 'string', example: '5 د.ك', description: 'Arabic display name' },
                    },
                },
                UpdatePricingRequest: {
                    type: 'object',
                    properties: {
                        baseFare: {
                            type: 'number',
                            minimum: 0,
                            example: 0,
                            description: 'بالفلس فقط (مش دينار). مثال: 500 = 500 فلس رسوم ثابتة',
                        },
                        pricePerMeter: {
                            type: 'number',
                            minimum: 0,
                            example: 1,
                            description: 'بالفلس لكل **متر** فقط. **1** = 1 فلس/متر | **2** = 2 فلس/متر | **0.5** = نص فلس/متر. JSON: `1`',
                        },
                        minFare: {
                            type: 'number',
                            minimum: 0,
                            example: 0,
                            description: 'بالفلس فقط — يُخزَّن فقط؛ لا يدخل في `/calculate-price`',
                        },
                        surgeMultiplier: {
                            type: 'number',
                            minimum: 0,
                            example: 1,
                            description: 'رقم عادي (مش فلس): 1 = بدون زحمة',
                        },
                    },
                    description: '**أرسل المبالغ بالفلس فقط — لا ترسل قيم بالدينار.** حقل واحد على الأقل. JWT (Authorize).',
                },
                UpdatePricingResponse: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', example: 'Pricing updated successfully' },
                        pricing: { $ref: '#/components/schemas/PricingConfig' },
                    },
                },
                OrderStatusValue: {
                    type: 'string',
                    enum: ['waiting', 'accepted', 'completed', 'cancelled', 'deleted'],
                    example: 'waiting',
                    description: 'Stored as text in DB: waiting=انتظار | accepted=مقبول | completed=مكتمل | cancelled=ملغي | deleted=محذوف',
                },
                UpdateOrderStatusRequest: {
                    type: 'object',
                    required: ['status'],
                    properties: {
                        status: { $ref: '#/components/schemas/OrderStatusValue' },
                    },
                },
                OrderStatusResponse: {
                    type: 'object',
                    properties: {
                        orderId: { type: 'integer', example: 1 },
                        status: { $ref: '#/components/schemas/OrderStatusValue' },
                        statusLabel: { $ref: '#/components/schemas/OrderStatusValue', description: 'Same as status (alias for clients)' },
                        orderType: { type: 'string', nullable: true, enum: ['ارسل', 'استلم'], example: 'ارسل', description: 'نوع الطلب: ارسل أو استلم' },
                        cancellationReason: { type: 'string', nullable: true, description: 'Set when order is cancelled (ملغي)' },
                        updatedAt: { type: 'string', format: 'date-time' },
                    },
                },
                CancelOrderRequest: {
                    type: 'object',
                    required: ['reason'],
                    properties: {
                        reason: { type: 'string', minLength: 1, maxLength: 2000, example: 'غيرت رأيي', description: 'سبب إلغاء الأوردر' },
                    },
                },
                CancelOrderResponse: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', example: 'Order cancelled successfully' },
                        orderId: { type: 'integer', example: 1 },
                        clientId: { type: 'string' },
                        status: { type: 'string', enum: ['cancelled'], example: 'cancelled', description: 'ملغي' },
                        statusLabel: { type: 'string', example: 'cancelled' },
                        cancellationReason: { type: 'string', example: 'غيرت رأيي' },
                        tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                    },
                },
                LocationInput: {
                    type: 'object',
                    properties: {
                        streetName: { type: 'string', example: 'شارع الخليج' },
                        entranceNumber: { type: 'string', example: '5A' },
                        phoneNumber: { type: 'string', example: '0501234567' },
                    },
                },
                PurchaseItem: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', example: 'Apple' },
                        quantity: { type: 'number', example: 2 },
                        price: { type: 'number', example: 1500 },
                    },
                },
                Task: {
                    type: 'object',
                    required: ['type'],
                    properties: {
                        taskId: { type: 'integer', example: 1, description: 'Global auto-increment across all orders (continues from previous tasks). Do not send in create request.' },
                        type: { type: 'string', enum: ['purchase', 'delivery'], example: 'purchase', description: 'Task type as text: purchase (مشتريات) or delivery (توصيل)' },
                        fromLatitude: { type: 'number', example: 29.3759 },
                        fromLongitude: { type: 'number', example: 47.9774 },
                        toLatitude: { type: 'number', example: 29.3700 },
                        toLongitude: { type: 'number', example: 47.9900 },
                        googleMapAddressFrom: { type: 'string', example: 'Kuwait City, Kuwait' },
                        googleMapAddressTo: { type: 'string', example: 'Salmiya, Kuwait' },
                        pickupLocation: { $ref: '#/components/schemas/LocationInput' },
                        deliveryLocation: { $ref: '#/components/schemas/LocationInput' },
                        paymentLocation: { type: 'string', example: 'At door' },
                        isClientPaidForItems: { type: 'boolean', example: false },
                        isDriverReimbursed: { type: 'boolean', example: false },
                        deliveryDescription: { type: 'string', example: 'Fragile – handle with care' },
                        itemPhotoBefore: { type: 'string', example: 'https://example.com/photo-before.jpg' },
                        itemPhotoAfter: { type: 'string', example: 'https://example.com/photo-after.jpg' },
                        purchaseItems: { type: 'array', items: { $ref: '#/components/schemas/PurchaseItem' } },
                    },
                },
                CreateOrderRequest: {
                    type: 'object',
                    required: ['clientId', 'tasks'],
                    description:
                        'عند إنشاء أوردر بخصم (`discountAmount` > 0): كود الخصم يُسجَّل لـ `clientId` مرة واحدة (لا يعيد نفس المستخدم)، والخصم الشخصي (`user_discount`) يُحذف. الكود يظل نشطاً لمستخدمين آخرين.',
                    properties: {
                        clientId: { type: 'string', example: '507f1f77bcf86cd799439011', description: 'Client user ID' },
                        originalDeliveryPrice: { type: 'number', nullable: true, example: 2000, description: '(اختياري) السعر الأصلي قبل الخصم بالفلس — أرسله فقط لو استُخدم خصم' },
                        totalDeliveryPrice: { type: 'number', example: 1500, description: 'سعر التوصيل النهائي بعد الخصم بالفلس (أو السعر الكامل لو مفيش خصم)' },
                        discountAmount: { type: 'number', example: 500, default: 0, description: '(اختياري) مقدار الخصم بالفلس — 0 لو مفيش خصم' },
                        discountPercentage: { type: 'number', nullable: true, example: 25, description: '(اختياري) نسبة الخصم 0–100 — null لو الخصم ثابت أو مفيش' },
                        discountCode: { type: 'string', nullable: true, example: 'SUMMER25', description: '(اختياري) الكود المستخدم — null لو مفيش كود' },
                        discountType: { type: 'string', nullable: true, enum: ['percentage', 'fixed', 'user_discount', null], example: 'percentage', description: '(اختياري) نوع الخصم: percentage | fixed | user_discount' },
                        totalPrice: { type: 'number', example: 5000, description: 'إجمالي سعر الطلب بالفلس' },
                        totalDistanceKm: { type: 'number', example: 12.5, description: 'المسافة الكلية بالكيلومتر' },
                        orderType: { type: 'string', nullable: true, enum: ['ارسل', 'استلم'], example: 'ارسل', description: '(اختياري) نوع الطلب: ارسل أو استلم' },
                        tasks: {
                            type: 'array',
                            minItems: 1,
                            items: { $ref: '#/components/schemas/Task' },
                            description: 'List of tasks in this order (min 1)',
                        },
                    },
                },
                OrderResponse: {
                    type: 'object',
                    properties: {
                        orderId: { type: 'integer', example: 1, description: 'Auto-incremented numeric order ID (1, 2, 3, …)' },
                        clientId: { type: 'string', example: '507f1f77bcf86cd799439011' },
                        representativeId: { type: 'string', nullable: true, example: '507f1f77bcf86cd799439022', description: 'MongoDB _id of the representative who accepted the order — null if still waiting' },
                        representativeName: { type: 'string', nullable: true, example: 'أحمد محمد', description: 'Full name (firstName + lastName) of the representative — populated from users collection (only when status=accepted)' },
                        representativePhone: { type: 'string', nullable: true, example: '01012345678', description: 'Phone number of the representative — populated from users collection' },
                        representativeProfileImage: { type: 'string', nullable: true, example: 'https://example.com/photo.jpg', description: 'Profile image URL of the representative — populated from users collection' },
                        originalDeliveryPrice: { type: 'number', nullable: true, example: 2000, description: 'السعر الأصلي للتوصيل قبل الخصم — null لو مفيش خصم' },
                        totalDeliveryPrice: { type: 'number', example: 1500, description: 'سعر التوصيل النهائي بعد الخصم (أو الكامل لو مفيش)' },
                        discountAmount: { type: 'number', example: 500, description: 'مقدار الخصم بالفلس — 0 لو مفيش خصم' },
                        discountPercentage: { type: 'number', nullable: true, example: 25, description: 'نسبة الخصم — null لو مفيش أو خصم ثابت' },
                        discountCode: { type: 'string', nullable: true, example: 'SUMMER25', description: 'الكود المستخدم — null لو مفيش' },
                        discountType: { type: 'string', nullable: true, example: 'percentage', description: 'نوع الخصم: percentage | fixed | user_discount | null' },
                        totalPrice: { type: 'number', example: 5000 },
                        totalDistanceKm: { type: 'number', example: 12.5 },
                        status: { $ref: '#/components/schemas/OrderStatusValue' },
                        statusLabel: { $ref: '#/components/schemas/OrderStatusValue', description: 'Same as status' },
                        orderType: { type: 'string', nullable: true, enum: ['ارسل', 'استلم'], example: 'ارسل', description: 'نوع الطلب: ارسل أو استلم' },
                        cancellationReason: { type: 'string', nullable: true, description: 'Filled when order is cancelled via POST /cancel' },
                        tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                    },
                },

                // ─── Discount Schemas (must stay inside components.schemas for $ref) ─
                DiscountCode: {
                type: 'object',
                properties: {
                    _id: { type: 'string', example: '665f1a2b3c4d5e6f7a8b9c0d' },
                    code: { type: 'string', example: 'WELCOME20', description: 'Always stored uppercase' },
                    description: { type: 'string', example: 'Welcome discount for new users' },
                    type: { type: 'string', enum: ['percentage', 'fixed'], example: 'percentage', description: 'percentage = % off delivery price | fixed = fils amount off' },
                    value: { type: 'number', example: 20, description: 'Percentage (0–100) or fils amount' },
                    isActive: { type: 'boolean', example: true },
                    isPermanent: { type: 'boolean', example: false },
                    expiresAt: { type: 'string', format: 'date-time', nullable: true, example: '2026-12-31T23:59:59.000Z' },
                    usageLimit: { type: 'integer', nullable: true, example: 100, description: 'null = unlimited (إجمالي مرات الاستخدام لكل المستخدمين)' },
                    usedCount: { type: 'integer', example: 0 },
                    usedByUserIds: {
                        type: 'array',
                        items: { type: 'string' },
                        example: ['507f1f77bcf86cd799439011'],
                        description: 'قائمة userId التي استخدمت الكود مرة واحدة — نفس المستخدم لا يعيد استخدامه',
                    },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                },
            },
            CreateDiscountCodeRequest: {
                type: 'object',
                required: ['code', 'type', 'value'],
                properties: {
                    code: { type: 'string', example: 'SUMMER25', minLength: 2, maxLength: 50, description: 'Unique code (auto-uppercased)' },
                    description: { type: 'string', example: 'Summer 2026 promo', default: '' },
                    type: { type: 'string', enum: ['percentage', 'fixed'], example: 'percentage' },
                    value: { type: 'number', example: 25, description: 'For percentage: 0–100. For fixed: fils amount (e.g. 500 = 0.5 KD off)' },
                    isActive: { type: 'boolean', default: true },
                    isPermanent: { type: 'boolean', default: false, description: 'If true, expiresAt is ignored' },
                    expiresAt: { type: 'string', format: 'date-time', example: '2026-12-31T23:59:59.000Z', description: 'Required when isPermanent is false' },
                    usageLimit: { type: 'integer', nullable: true, example: 500, description: 'null = unlimited uses' },
                },
            },
            UpdateDiscountCodeRequest: {
                type: 'object',
                properties: {
                    description: { type: 'string' },
                    type: { type: 'string', enum: ['percentage', 'fixed'] },
                    value: { type: 'number', minimum: 0 },
                    isActive: { type: 'boolean' },
                    isPermanent: { type: 'boolean' },
                    expiresAt: { type: 'string', format: 'date-time', nullable: true },
                    usageLimit: { type: 'integer', nullable: true },
                },
            },
            ApplyDiscountCodeRequest: {
                type: 'object',
                required: ['userId', 'code', 'deliveryPrice'],
                properties: {
                    userId: { type: 'string', example: '507f1f77bcf86cd799439011', description: 'MongoDB _id — كل مستخدم يستخدم الكود مرة واحدة فقط' },
                    code: { type: 'string', example: 'SUMMER25' },
                    deliveryPrice: { type: 'number', example: 2000, description: 'Original delivery price in fils (e.g. 2000 = 2 KD)' },
                },
            },
            ApplyDiscountCodeResponse: {
                type: 'object',
                properties: {
                    originalPrice: { type: 'number', example: 2000 },
                    discountCode: { type: 'string', example: 'SUMMER25' },
                    discountType: { type: 'string', enum: ['percentage', 'fixed'], example: 'percentage' },
                    discountValue: { type: 'number', example: 25 },
                    discountAmount: { type: 'number', example: 500, description: 'Amount deducted in fils' },
                    finalPrice: { type: 'number', example: 1500, description: 'deliveryPrice − discountAmount' },
                    description: { type: 'string', example: 'Summer 2026 promo' },
                    isPermanent: { type: 'boolean', example: false },
                    expiresAt: { type: 'string', format: 'date-time', nullable: true },
                },
            },
            ApplyMyDiscountRequest: {
                type: 'object',
                required: ['userId', 'deliveryPrice'],
                properties: {
                    userId: { type: 'string', example: '507f1f77bcf86cd799439011', description: 'MongoDB _id of the user' },
                    deliveryPrice: { type: 'number', example: 3000, description: 'Delivery price in fils before discount' },
                },
            },
            ApplyMyDiscountResponse: {
                type: 'object',
                properties: {
                    originalPrice: { type: 'number', example: 3000 },
                    discountPercentage: { type: 'number', example: 15 },
                    discountAmount: { type: 'number', example: 450, description: 'Amount deducted in fils' },
                    finalPrice: { type: 'number', example: 2550 },
                    isPermanent: { type: 'boolean', example: true },
                    expiresAt: { type: 'string', format: 'date-time', nullable: true },
                },
            },
            UserDiscount: {
                type: 'object',
                properties: {
                    _id: { type: 'string', example: '665f1a2b3c4d5e6f7a8b9c0e' },
                    userId: { type: 'string', example: '507f1f77bcf86cd799439011', description: 'MongoDB _id of the user' },
                    discountPercentage: { type: 'number', example: 15, description: 'Percentage off delivery price (0–100)' },
                    isPermanent: { type: 'boolean', example: true },
                    expiresAt: { type: 'string', format: 'date-time', nullable: true },
                    isActive: { type: 'boolean', example: true },
                    assignedBy: { type: 'string', example: '507f1f77bcf86cd799439022', description: 'Admin user id who assigned this discount' },
                    note: { type: 'string', example: 'VIP customer' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                },
            },
            AssignUserDiscountRequest: {
                type: 'object',
                required: ['userId', 'discountPercentage'],
                properties: {
                    userId: { type: 'string', example: '507f1f77bcf86cd799439011', description: 'User _id to assign discount to' },
                    discountPercentage: { type: 'number', example: 15, minimum: 0, maximum: 100, description: 'Discount percentage (0–100)' },
                    isPermanent: { type: 'boolean', default: false, description: 'If true, expiresAt is ignored' },
                    expiresAt: { type: 'string', format: 'date-time', example: '2027-01-01T00:00:00.000Z', description: 'Required when isPermanent is false' },
                    note: { type: 'string', example: 'VIP customer', default: '' },
                },
            },
            UpdateUserDiscountRequest: {
                type: 'object',
                properties: {
                    discountPercentage: { type: 'number', minimum: 0, maximum: 100 },
                    isPermanent: { type: 'boolean' },
                    expiresAt: { type: 'string', format: 'date-time', nullable: true },
                    isActive: { type: 'boolean' },
                    note: { type: 'string' },
                },
            },

            // ─── Notification Schemas ─────────────────────────────────────────
            SaveTokenRequest: {
                type: 'object',
                required: ['userId', 'token'],
                properties: {
                    userId: { type: 'string', example: 'user_abc123', description: 'Unique identifier for the user (e.g. MongoDB _id or app-level id)' },
                    token: { type: 'string', example: 'fcm_device_token_here', description: 'Firebase Cloud Messaging device token' },
                },
            },
            SaveTokenResponse: {
                type: 'object',
                properties: {
                    message: { type: 'string', example: 'Token saved successfully' },
                    userId: { type: 'string', example: 'user_abc123' },
                    fcmToken: { type: 'string', example: 'fcm_device_token_here' },
                },
            },
            FcmUser: {
                type: 'object',
                properties: {
                    userId: { type: 'string', example: 'user_abc123' },
                    fcmToken: { type: 'string', example: 'fcm_device_token_here' },
                },
            },
            GetUsersResponse: {
                type: 'object',
                properties: {
                    count: { type: 'integer', example: 5 },
                    users: { type: 'array', items: { $ref: '#/components/schemas/FcmUser' } },
                },
            },
            SendToUserRequest: {
                type: 'object',
                required: ['userId', 'title', 'body'],
                properties: {
                    userId: { type: 'string', example: 'user_abc123' },
                    title: { type: 'string', example: 'Your order is on the way!' },
                    body: { type: 'string', example: 'Your driver is 5 minutes away.' },
                },
            },
            BroadcastRequest: {
                type: 'object',
                required: ['title', 'body'],
                properties: {
                    title: { type: 'string', example: 'Special Offer!' },
                    body: { type: 'string', example: 'Get 20% off your next delivery this weekend.' },
                },
            },
            BroadcastResponse: {
                type: 'object',
                properties: {
                    message: { type: 'string', example: 'Broadcast complete' },
                    totalRecipients: { type: 'integer', example: 42 },
                    successCount: { type: 'integer', example: 40 },
                    failureCount: { type: 'integer', example: 2 },
                    invalidTokensRemoved: { type: 'integer', example: 2 },
                },
                },  // closes schemas
        },      // closes components (inner)
        },      // closes components (outer - balance fix)
    },          // closes definition
    apis: [],
};

// ── Paths defined separately to avoid nesting issues ────────────────────
// These are assigned to options.definition.paths after options is defined.
const _swaggerPaths = {
            '/api/auth/register': {
                post: {
                    tags: ['Auth'],
                    summary: 'Register a new user',
                    description: 'Creates a new user and sends a verification OTP to the provided email. Response includes `userType` (default NormalUser). To use another type, set `userType` on the user document in MongoDB; the next login returns that value.',
                    operationId: 'register',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/RegisterRequest' },
                            },
                        },
                    },
                    responses: {
                        '201': {
                            description: 'Success',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterResponse' } } },
                        },
                    },
                },
            },
            '/api/auth/login': {
                post: {
                    tags: ['Auth'],
                    summary: 'Login user',
                    description: 'Returns user and JWT if credentials are valid and email is verified. Response includes `userType` (default `NormalUser`; set per account in DB).',
                    operationId: 'login',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/LoginRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/auth/verify-email': {
                post: {
                    tags: ['Auth'],
                    summary: 'Verify email with OTP',
                    description: 'Verifies the user email using the 6-digit OTP and returns a JWT and user fields including `userType` (default NormalUser).',
                    operationId: 'verifyEmail',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/VerifyEmailRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/auth/resend-otp': {
                post: {
                    tags: ['Auth'],
                    summary: 'Resend verification OTP',
                    description: 'Sends a new OTP to the email. Limited to 3 requests per hour.',
                    operationId: 'resendOtp',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ResendOtpRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/auth/change-password': {
                post: {
                    tags: ['Auth'],
                    summary: 'Change password',
                    description: 'Client sends userId (account _id) + old password + new password. Server verifies userId and old password, then updates password.',
                    operationId: 'changePassword',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ChangePasswordRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/auth/forgot-password': {
                post: {
                    tags: ['Auth'],
                    summary: 'Forgot password',
                    description: 'Send email with verification code. Check DB for email; if exists, send OTP to email.',
                    operationId: 'forgotPassword',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ForgotPasswordRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/auth/verify-reset-code': {
                post: {
                    tags: ['Auth'],
                    summary: 'Verify password reset OTP',
                    description: 'Step 2 of forgot-password flow. Verifies the 6-digit OTP sent to email and returns a short-lived resetToken (valid 15 min).',
                    operationId: 'verifyResetCode',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/VerifyResetCodeRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Code verified – returns resetToken' },
                    },
                },
            },
            '/api/auth/reset-password': {
                post: {
                    tags: ['Auth'],
                    summary: 'Reset password',
                    description: 'Step 3 of forgot-password flow. Use the resetToken from verify-reset-code + new password + confirm password to reset.',
                    operationId: 'resetPassword',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ResetPasswordRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Password reset successfully' },
                    },
                },
            },
            '/api/auth/google-signin': {
                post: {
                    tags: ['Auth'],
                    summary: 'Google Sign-In / Sign-Up',
                    description: [
                        '**Mobile Google Sign-In flow using Firebase ID Token:**',
                        '',
                        '1. Flutter calls `google_sign_in` + `firebase_auth` to get a **Firebase ID Token**',
                        '2. Send the token here as `{ "idToken": "..." }`',
                        '3. Server verifies via **firebase-admin SDK** and finds/creates the user in MongoDB',
                        '4. Returns our own **JWT** (same as email login) + user data',
                        '',
                        '**New users:** `isProfileCompleted: false` → redirect to phone/governorate screen.',
                        '**Returning users:** `isProfileCompleted: true` → go directly to dashboard.',
                        '',
                        '⚠️ **Requires:** SHA-1 and SHA-256 fingerprints in Firebase Console + Google Sign-In enabled in Firebase Authentication.',
                    ].join('\n'),
                    operationId: 'googleSignIn',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['idToken'],
                                    properties: {
                                        idToken: {
                                            type: 'string',
                                            description: 'Firebase ID Token obtained from firebase_auth after Google Sign-In',
                                            example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ii...',
                                        },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Sign-In / Sign-Up successful — returns JWT + user data',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            _id: { type: 'string', example: '507f1f77bcf86cd799439011' },
                                            firstName: { type: 'string', example: 'Ahmed' },
                                            lastName: { type: 'string', example: 'Mohamed' },
                                            email: { type: 'string', example: 'user@gmail.com' },
                                            phone: { type: 'string', nullable: true, example: null, description: 'null for new Google users (collected later)' },
                                            isAdmin: { type: 'boolean', example: false },
                                            userType: { type: 'string', example: 'NormalUser' },
                                            profileImage: { type: 'string', nullable: true, example: 'https://lh3.googleusercontent.com/...' },
                                            isProfileCompleted: { type: 'boolean', example: false, description: 'false → redirect to complete profile; true → go to dashboard' },
                                            token: { type: 'string', description: 'App JWT token for subsequent API calls' },
                                        },
                                    },
                                },
                            },
                        },
                        '400': { description: 'idToken is missing or Google account has no email' },
                        '401': { description: 'Invalid or expired Firebase ID Token' },
                    },
                },
            },
            '/api/auth/complete-google-profile': {
                post: {
                    tags: ['Auth'],
                    summary: 'Complete Google profile (first-time setup)',
                    description: [
                        '**Called after the first Google Sign-In** when `isProfileCompleted` is `false`.',
                        '',
                        'Allows a new Google user to:',
                        '- Set a **phone number** (stored in their account)',
                        '- Create a **password** (hashed & stored) so they can later sign in with email + password',
                        '',
                        'After success, `isProfileCompleted` is set to `true` and a fresh JWT is returned.',
                        '',
                        '**Flutter flow:** `GovernorateSelectionPage` → enter phone + password + confirm → POST here.',
                    ].join('\n'),
                    operationId: 'completeGoogleProfile',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['userId', 'phone', 'password', 'confirmPassword'],
                                    properties: {
                                        userId: {
                                            type: 'string',
                                            description: 'MongoDB _id of the Google user (from google-signin response _id)',
                                            example: '507f1f77bcf86cd799439011',
                                        },
                                        phone: {
                                            type: 'string',
                                            description: 'Phone number with country code (e.g. +201012345678)',
                                            example: '+201012345678',
                                            minLength: 7,
                                            maxLength: 20,
                                        },
                                        password: {
                                            type: 'string',
                                            format: 'password',
                                            description: 'New password (min 6 characters)',
                                            minLength: 6,
                                            example: 'MyPassword123',
                                        },
                                        confirmPassword: {
                                            type: 'string',
                                            format: 'password',
                                            description: 'Must match password',
                                            example: 'MyPassword123',
                                        },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Profile completed successfully — returns updated user data + new JWT',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            message: { type: 'string', example: 'Profile completed successfully' },
                                            _id: { type: 'string', example: '507f1f77bcf86cd799439011' },
                                            firstName: { type: 'string', example: 'Ahmed' },
                                            lastName: { type: 'string', example: 'Mohamed' },
                                            email: { type: 'string', example: 'user@gmail.com' },
                                            phone: { type: 'string', example: '+201012345678' },
                                            isAdmin: { type: 'boolean', example: false },
                                            userType: { type: 'string', example: 'NormalUser' },
                                            profileImage: { type: 'string', nullable: true },
                                            isProfileCompleted: { type: 'boolean', example: true },
                                            token: { type: 'string', description: 'Fresh JWT token' },
                                        },
                                    },
                                },
                            },
                        },
                        '400': { description: 'Missing fields, passwords do not match, or validation error' },
                        '404': { description: 'User not found' },
                    },
                },
            },
            '/api/users': {
                get: {
                    tags: ['Users'],
                    summary: 'Get all users',
                    description: 'Returns all users. Requires JWT (admin). Can filter by userType.',
                    operationId: 'getAllUsers',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: 'userType',
                            in: 'query',
                            required: false,
                            schema: { type: 'string', example: 'Agent' },
                            description: 'Filter users by type (e.g. Agent)',
                        },
                    ],
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/users/online-representatives/locations': {
                get: {
                    tags: ['Users'],
                    summary: 'Get all online available representatives with their last known location',
                    description: 'Returns all representatives who are available and have updated their location within the last 15 minutes.',
                    responses: {
                        '200': { description: 'List of online representatives' },
                    },
                },
            },
            '/api/users/{id}/online-location': {
                patch: {
                    tags: ['Users'],
                    summary: 'Update live location for an online representative',
                    description: 'The representative app polls this endpoint every 3 minutes to update their live location.',
                    security: [{ bearerAuth: [] }],
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                            description: 'Representative MongoDB _id',
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        lat: { type: 'number', example: 30.0444 },
                                        lng: { type: 'number', example: 31.2357 },
                                    },
                                    required: ['lat', 'lng'],
                                },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Location updated' },
                    },
                },
            },
            '/api/users/profile/{id}': {
                get: {
                    tags: ['Users'],
                    summary: 'Get profile by ID',
                    description: 'Send user id; returns firstName, lastName, email, and profile image from database.',
                    operationId: 'getProfile',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                            description: 'User MongoDB _id',
                        },
                    ],
                    responses: {
                        '200': { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } },
                    },
                },
            },
            '/api/users/{id}/profile-image': {
                put: {
                    tags: ['Users'],
                    summary: 'Upload profile image',
                    description: 'Send user id in path and upload image (form field: image). Allowed: JPEG, PNG, GIF, WebP. Max 5MB.',
                    operationId: 'uploadProfileImage',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                            description: 'User MongoDB _id',
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'multipart/form-data': {
                                schema: {
                                    type: 'object',
                                    required: ['image'],
                                    properties: {
                                        image: { type: 'string', format: 'binary', description: 'Profile image file' },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/users/{id}': {
                get: {
                    tags: ['Users'],
                    summary: 'Get user by ID',
                    description: 'Returns a single user. Requires JWT (owner or admin).',
                    operationId: 'getUserById',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                            description: 'User MongoDB _id',
                        },
                    ],
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
                put: {
                    tags: ['Users'],
                    summary: 'Update user',
                    description: 'Update firstName and/or lastName only. Requires JWT (owner or admin).',
                    operationId: 'updateUser',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                            description: 'User MongoDB _id',
                        },
                    ],
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/UserUpdateRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
                delete: {
                    tags: ['Users'],
                    summary: 'Delete user',
                    description: 'Deletes user by ID. Requires JWT (owner or admin).',
                    operationId: 'deleteUser',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                            description: 'User MongoDB _id',
                        },
                    ],
                    responses: {
                        '200': { description: 'Success' },
                    },
                },
            },
            '/api/pricing': {
                get: {
                    tags: ['Pricing'],
                    summary: 'Get current pricing config',
                    description: '**أدمن فقط** (isAdmin: true). Amounts in fils only (not KD).',
                    operationId: 'getPricing',
                    security: [{ BearerAuth: [] }],
                    responses: {
                        '200': { description: 'Current pricing config' },
                    },
                },
                put: {
                    tags: ['Pricing'],
                    summary: 'Update pricing config',
                    description: `**أدمن فقط** (isAdmin: true). المبالغ بالفلس فقط.

- \`baseFare\` / \`pricePerMeter\` / \`minFare\`: بالفلس (كسور مسموحة).
- \`surgeMultiplier\`: رقم عادي.

الرد: نفس هيكل GET + \`*_name_ar\` للعرض.`,
                    operationId: 'updatePricing',
                    security: [{ BearerAuth: [] }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/UpdatePricingRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'تم التحديث' },
                    },
                },
            },
            '/api/orders': {
                get: {
                    tags: ['Orders'],
                    summary: 'List orders (filter by status / client)',
                    description: `Returns orders sorted by \`orderId\` descending.

**Query (optional):**
- \`status\` — filter: \`waiting\` (انتظار) | \`accepted\` | \`completed\` (مكتمل) | \`cancelled\` (ملغي) | \`deleted\` (محذوف)
- \`clientId\` — filter orders for one client

Omit both to return all orders.`,
                    operationId: 'listOrders',
                    parameters: [
                        {
                            name: 'status',
                            in: 'query',
                            required: false,
                            schema: { $ref: '#/components/schemas/OrderStatusValue' },
                            description: 'Filter by order status (text, same as DB)',
                        },
                        {
                            name: 'clientId',
                            in: 'query',
                            required: false,
                            schema: { type: 'string', example: '507f1f77bcf86cd799439011' },
                            description: 'Filter by client user id',
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'Array of orders',
                            content: {
                                'application/json': {
                                    schema: { type: 'array', items: { $ref: '#/components/schemas/OrderResponse' } },
                                },
                            },
                        },
                    },
                },
                post: {
                    tags: ['Orders'],
                    summary: 'Create a new order',
                    description: `Creates a new order with an auto-incremented numeric \`orderId\` (1, 2, 3, …).

**Order status after creation:** \`waiting\` (انتظار) — stored as text in DB.

**Order type is per task** using \`tasks[].type\` = \`purchase\` or \`delivery\`.

Each task gets a global auto-increment \`taskId\` (continues across all orders, not reset per order). Mixed task types in one order are supported.

You can include multiple tasks inside a single order.

**خصم (بعد نجاح الحفظ):**
- كود (\`percentage\` / \`fixed\` + \`discountCode\`): يُسجَّل \`clientId\` في \`usedByUserIds\` ويُزاد \`usedCount\` — **نفس المستخدم لا يعيد الكود**؛ باقي المستخدمين ما زالوا يقدرون يستخدموه حسب \`usageLimit\`.
- خصم شخصي (\`user_discount\`): يُحذف سجل الخصم لهذا المستخدم.`,
                    operationId: 'createOrder',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CreateOrderRequest' },
                            },
                        },
                    },
                    responses: {
                        '201': {
                            description: 'Order created successfully',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } },
                        },
                    },
                },
            },
            '/api/orders/user/{userId}': {
                get: {
                    tags: ['Orders'],
                    summary: 'List all orders for a user',
                    description:
                        'Returns **all** orders where `clientId` matches the user id (MongoDB `_id` string). Includes every status: waiting, accepted, completed, cancelled, deleted. Sorted by `orderId` descending.',
                    operationId: 'listOrdersByUserId',
                    parameters: [
                        {
                            name: 'userId',
                            in: 'path',
                            required: true,
                            schema: { type: 'string', example: '507f1f77bcf86cd799439011' },
                            description: 'User id — same value stored as `clientId` on each order',
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'Array of orders for this user',
                            content: {
                                'application/json': {
                                    schema: { type: 'array', items: { $ref: '#/components/schemas/OrderResponse' } },
                                },
                            },
                        },
                    },
                },
            },
            '/api/orders/waiting': {
                get: {
                    tags: ['Orders'],
                    summary: 'List all waiting orders (for representative)',
                    description: 'Returns all orders with status `waiting` (انتظار). Used by representatives to see available orders to accept. Response: `{ succeeded: true, data: [...], count: N }`.',
                    operationId: 'listWaitingOrders',
                    responses: {
                        '200': {
                            description: 'List of waiting orders',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            succeeded: { type: 'boolean', example: true },
                                            count: { type: 'integer', example: 3 },
                                            data: { type: 'array', items: { $ref: '#/components/schemas/OrderResponse' } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            '/api/orders/{id}': {
                get: {
                    tags: ['Orders'],
                    summary: '🔍 Get order by ID',
                    description: [
                        'Returns **full details** for a single order identified by its **numeric `orderId`** (the auto-incremented integer, not the MongoDB `_id`).',
                        '',
                        '**Includes:**',
                        '- All order fields (status, price, tasks, locations…)',
                        '- Representative info if order is accepted: `representativeName`, `representativePhone`, `representativeProfileImage`',
                        '- Vehicle info: `vehicleNumber`, `vehicleColor`, `vehicleModel`, `vehicleImage`',
                        '',
                        '**Use case:** Track who accepted an order and monitor order lifecycle from the Swagger UI.',
                    ].join('\n'),
                    operationId: 'getOrderById',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'integer', example: 1 },
                            description: 'Numeric order ID (orderId, not MongoDB _id)',
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'Full order details with representative info (if assigned)',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/OrderResponse' },
                                },
                            },
                        },
                        '404': { description: 'Order not found' },
                    },
                },
            },
            '/api/orders/{id}/accept': {
                patch: {
                    tags: ['Orders'],
                    summary: 'Accept a waiting order (representative)',
                    description: 'Sets order status from `waiting` to `accepted` and records `representativeId`. Returns **409** if already accepted by another representative.',
                    operationId: 'acceptOrder',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'integer', example: 1 },
                            description: 'Numeric order ID',
                        },
                    ],
                    requestBody: {
                        required: false,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        representativeId: {
                                            type: 'string',
                                            example: '507f1f77bcf86cd799439011',
                                            description: 'MongoDB _id of the representative (optional)',
                                        },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Order accepted successfully',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/OrderResponse' },
                                },
                            },
                        },
                        '404': { description: 'Order not found' },
                        '409': { description: 'Order is already accepted or no longer available' },
                    },
                },
            },

            '/api/orders/{id}': {
                get: {
                    tags: ['Orders'],
                    summary: 'Get order by numeric ID',
                    description: 'Fetches a single order by its auto-incremented numeric `orderId` (e.g. 1, 2, 3). Response includes `statusLabel` and optional `cancellationReason` if cancelled.',
                    operationId: 'getOrderById',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'integer', example: 1 },
                            description: 'Numeric order ID (auto-incremented)',
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'Order found',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } },
                        },
                    },
                },
            },
            '/api/orders/{id}/cancel': {
                post: {
                    tags: ['Orders'],
                    summary: 'Cancel order',
                    description: 'Sets order status to **cancelled** (ملغي) and stores the cancellation **reason**. Fails with 400 if already cancelled or deleted.',
                    operationId: 'cancelOrder',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'integer', example: 1 },
                            description: 'Numeric order ID',
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CancelOrderRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Order cancelled',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/CancelOrderResponse' },
                                },
                            },
                        },
                    },
                },
            },
            '/api/orders/{id}/status': {
                get: {
                    tags: ['Orders'],
                    summary: 'Get current order status',
                    description: 'Returns the current status as text: `waiting` | `accepted` | `completed` | `cancelled` | `deleted`.',
                    operationId: 'getOrderStatus',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'integer', example: 1 },
                            description: 'Numeric order ID',
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'Current status',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/OrderStatusResponse' },
                                },
                            },
                        },
                    },
                },
                patch: {
                    tags: ['Orders'],
                    summary: 'Update order status',
                    description: 'Changes the status of an order. Send **string** `status` in the body: `waiting` | `accepted` | `completed` | `cancelled` | `deleted`.',
                    operationId: 'updateOrderStatus',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'integer', example: 1 },
                            description: 'Numeric order ID',
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/UpdateOrderStatusRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Status updated',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/OrderStatusResponse' },
                                },
                            },
                        },
                    },
                },
            },
            // ─── Task Lifecycle Endpoints ──────────────────────────────────────
            '/api/orders/{orderId}/tasks/{taskId}/pickup': {
                patch: {
                    tags: ['Orders', 'Representative', 'Tasks'],
                    summary: 'Mark task as picked up (تم الاستلام)',
                    description: `Sets **task.taskStatus = "picked_up"** and records **arrivedAt** timestamp.
Emits **task:picked_up** via Socket.IO so clients can update their UI immediately.

**Flow:** Representative presses "تم الاستلام" → camera opens for before-photo → task moves to delivery phase.`,
                    operationId: 'markTaskPickedUp',
                    parameters: [
                        { name: 'orderId', in: 'path', required: true, schema: { type: 'integer', example: 5 }, description: 'Numeric order ID' },
                        { name: 'taskId',  in: 'path', required: true, schema: { type: 'integer', example: 12 }, description: 'Numeric task ID' },
                    ],
                    responses: {
                        '200': {
                            description: 'Task marked as picked_up',
                            content: { 'application/json': { schema: { type: 'object', properties: {
                                succeeded: { type: 'boolean', example: true },
                                orderId:   { type: 'integer', example: 5 },
                                taskId:    { type: 'integer', example: 12 },
                                taskStatus:{ type: 'string', example: 'picked_up' },
                                arrivedAt: { type: 'string', format: 'date-time' },
                            }}}},
                        },
                        '404': { description: 'Order or task not found' },
                        '409': { description: 'Task already completed' },
                    },
                },
            },
            '/api/orders/{orderId}/tasks/{taskId}/photo/before': {
                post: {
                    tags: ['Orders', 'Representative', 'Tasks'],
                    summary: 'Upload before-pickup photo (بيفور فوتو)',
                    description: `Upload the **itemPhotoBefore** image for a task. Accepts **multipart/form-data** with field \`photo\`.`,
                    operationId: 'uploadTaskPhotoBefore',
                    parameters: [
                        { name: 'orderId', in: 'path', required: true, schema: { type: 'integer', example: 5 } },
                        { name: 'taskId',  in: 'path', required: true, schema: { type: 'integer', example: 12 } },
                    ],
                    requestBody: {
                        required: true,
                        content: { 'multipart/form-data': { schema: { type: 'object', required: ['photo'], properties: {
                            photo: { type: 'string', format: 'binary', description: 'JPEG/PNG/WebP image file (max 15 MB)' },
                        }}}},
                    },
                    responses: {
                        '200': { description: 'Photo saved — returns itemPhotoBefore URL',
                            content: { 'application/json': { schema: { type: 'object', properties: {
                                succeeded: { type: 'boolean' },
                                orderId: { type: 'integer' },
                                taskId: { type: 'integer' },
                                itemPhotoBefore: { type: 'string', format: 'uri', example: 'https://example.com/uploads/order-photos/order_5_task_12_1234567890.jpg' },
                            }}}},
                        },
                        '400': { description: 'photo file is missing' },
                        '404': { description: 'Order or task not found' },
                    },
                },
            },
            '/api/orders/{orderId}/tasks/{taskId}/deliver': {
                post: {
                    tags: ['Orders', 'Representative', 'Tasks'],
                    summary: 'Mark task delivered + upload after-photo (تم التسليم)',
                    description: `Sets **task.taskStatus = "completed"** and records **deliveredAt**. Optionally accepts **photo** (after-delivery image).

**Auto-complete logic:**
- If **all tasks** in the order are now \`completed\` → **order.status** is set to \`completed\`
- Emits **task:delivered** (always) + **order:completed** (if all done) via Socket.IO
- The client receives **order:completed** and navigates to the **Rating Page** automatically`,
                    operationId: 'deliverTask',
                    parameters: [
                        { name: 'orderId', in: 'path', required: true, schema: { type: 'integer', example: 5 } },
                        { name: 'taskId',  in: 'path', required: true, schema: { type: 'integer', example: 12 } },
                    ],
                    requestBody: {
                        required: false,
                        content: { 'multipart/form-data': { schema: { type: 'object', properties: {
                            photo: { type: 'string', format: 'binary', description: 'Optional after-delivery photo (JPEG/PNG/WebP, max 15 MB)' },
                        }}}},
                    },
                    responses: {
                        '200': { description: 'Task completed — returns order status and allTasksCompleted flag',
                            content: { 'application/json': { schema: { type: 'object', properties: {
                                succeeded: { type: 'boolean', example: true },
                                orderId: { type: 'integer', example: 5 },
                                taskId: { type: 'integer', example: 12 },
                                taskStatus: { type: 'string', example: 'completed' },
                                deliveredAt: { type: 'string', format: 'date-time' },
                                itemPhotoAfter: { type: 'string', format: 'uri', nullable: true },
                                allTasksCompleted: { type: 'boolean', example: true },
                                orderStatus: { type: 'string', example: 'completed' },
                            }}}},
                        },
                        '404': { description: 'Order or task not found' },
                        '409': { description: 'Task already completed' },
                    },
                },
            },
            '/api/orders/{orderId}/tasks/{taskId}/status': {
                get: {
                    tags: ['Orders', 'Tasks'],
                    summary: 'Get single task status (lightweight)',
                    description: 'Returns the current `taskStatus`, timestamps, and photo URLs for a specific task. Does not return full order data.',
                    operationId: 'getTaskStatus',
                    parameters: [
                        { name: 'orderId', in: 'path', required: true, schema: { type: 'integer', example: 5 } },
                        { name: 'taskId',  in: 'path', required: true, schema: { type: 'integer', example: 12 } },
                    ],
                    responses: {
                        '200': { description: 'Task status',
                            content: { 'application/json': { schema: { type: 'object', properties: {
                                orderId: { type: 'integer' },
                                taskId: { type: 'integer' },
                                taskStatus: { type: 'string', enum: ['pending', 'picked_up', 'completed'] },
                                arrivedAt: { type: 'string', format: 'date-time', nullable: true },
                                deliveredAt: { type: 'string', format: 'date-time', nullable: true },
                                itemPhotoBefore: { type: 'string', format: 'uri', nullable: true },
                                itemPhotoAfter: { type: 'string', format: 'uri', nullable: true },
                            }}}},
                        },
                        '404': { description: 'Order or task not found' },
                    },
                },
            },
            // ─── Representative Release Order ─────────────────────────────────
            '/api/orders/{id}/release': {
                patch: {
                    tags: ['Orders', 'Representative'],
                    summary: 'Release accepted order → back to waiting',
                    description: `**Representative only.** Releases an accepted order back to \`waiting\` status.
- Clears \`representativeId\`
- Resets status to \`waiting\`
- Emits **order:status_changed** \`{ status: "waiting" }\` via Socket.IO so the client's waiting UI is restored instantly.

**Possible errors:**
- \`409 Conflict\` — order is not in \`accepted\` state`,
                    operationId: 'releaseOrder',
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            schema: { type: 'integer', example: 5 },
                            description: 'Numeric order ID',
                        },
                    ],
                    requestBody: {
                        required: false,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        reason: {
                                            type: 'string',
                                            example: 'عذرًا لا أستطيع إتمام الطلب',
                                            description: 'Optional reason for releasing the order',
                                        },
                                        representativeId: {
                                            type: 'string',
                                            example: '507f1f77bcf86cd799439011',
                                            description: 'Optional representative ID for logging',
                                        },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Order released — status is now waiting',
                            content: {
                                'application/json': {
                                    schema: {
                                        allOf: [
                                            { $ref: '#/components/schemas/OrderResponse' },
                                            {
                                                type: 'object',
                                                properties: {
                                                    succeeded: { type: 'boolean', example: true },
                                                    message: { type: 'string', example: 'Order released back to waiting successfully' },
                                                },
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                        '404': { description: 'Order not found' },
                        '409': {
                            description: 'Order is not in accepted state — cannot release',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            message: { type: 'string', example: "Cannot release order with status 'waiting'. Only accepted orders can be released." },
                                            currentStatus: { type: 'string', example: 'waiting' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            // ─── Discount Paths ───────────────────────────────────────────────
            '/api/discounts/apply-code': {
                post: {
                    tags: ['Discounts'],
                    summary: 'Apply a discount code to delivery price',
                    description: '**بدون توكين (Public).** أرسل `userId` + `code` + `deliveryPrice`. **كل مستخدم يستخدم الكود مرة واحدة فقط** (يُتحقق من `usedByUserIds` بعد أول أوردر). الأسعار بالـ **فلس**.',
                    operationId: 'applyDiscountCode',
                    security: [],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ApplyDiscountCodeRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Discount applied — returns original price, discount amount, and final price',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/ApplyDiscountCodeResponse' },
                                },
                            },
                        },
                        '400': { description: 'Code inactive, expired, usage limit, or this user already used this code' },
                        '404': { description: 'Discount code not found' },
                    },
                },
            },
            '/api/discounts/my-discount': {
                get: {
                    tags: ['Discounts'],
                    summary: 'Get personal discount info by userId',
                    description: '**بدون توكين (Public).** بيرجع معلومات الخصم الشخصي اللي الأدمن حطه على اليوزر ده. بعت `userId` كـ query parameter. بيحتوي على `isExpired` عشان تعرف انتهى ولا لأ.',
                    operationId: 'getMyDiscount',
                    security: [],
                    parameters: [
                        {
                            name: 'userId',
                            in: 'query',
                            required: true,
                            schema: { type: 'string', example: '507f1f77bcf86cd799439011' },
                            description: 'MongoDB _id of the user',
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'User discount details',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/UserDiscount' },
                                },
                            },
                        },
                        '400': { description: 'userId is missing' },
                        '404': { description: 'No discount assigned to this user' },
                    },
                },
            },
            '/api/discounts/my-discount/apply': {
                post: {
                    tags: ['Discounts'],
                    summary: 'Apply personal discount to a delivery price',
                    description: '**بدون توكين (Public).** بيطبق الخصم الشخصي بتاع اليوزر على سعر التوصيل. بعت `userId` + `deliveryPrice` في الـ body → يرجع السعر الأصلي والمبلغ المخصوم والسعر النهائي.',
                    operationId: 'applyMyDiscount',
                    security: [],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ApplyMyDiscountRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Discount applied',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/ApplyMyDiscountResponse' },
                                },
                            },
                        },
                        '400': { description: 'Discount is inactive, expired, or missing userId/deliveryPrice' },
                        '404': { description: 'No discount assigned to this user' },
                    },
                },
            },
            '/api/discounts/codes': {
                post: {
                    tags: ['Discounts'],
                    summary: 'Create a new discount code',
                    description: '**Admin JWT required.** Creates a new discount code usable by any user. `type: "percentage"` — value is 0–100%. `type: "fixed"` — value is a fils amount deducted from delivery price. When `isPermanent: false`, `expiresAt` is required.',
                    operationId: 'createDiscountCode',
                    security: [{ BearerAuth: [] }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CreateDiscountCodeRequest' },
                            },
                        },
                    },
                    responses: {
                        '201': {
                            description: 'Discount code created',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/DiscountCode' },
                                },
                            },
                        },
                        '400': { description: 'Validation error' },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                        '409': { description: 'Code already exists' },
                    },
                },
                get: {
                    tags: ['Discounts'],
                    summary: 'List all discount codes',
                    description: '**Admin JWT required.** Returns all discount codes sorted by newest first.',
                    operationId: 'listDiscountCodes',
                    security: [{ BearerAuth: [] }],
                    responses: {
                        '200': {
                            description: 'List of discount codes',
                            content: {
                                'application/json': {
                                    schema: { type: 'array', items: { $ref: '#/components/schemas/DiscountCode' } },
                                },
                            },
                        },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                    },
                },
            },
            '/api/discounts/codes/{id}': {
                get: {
                    tags: ['Discounts'],
                    summary: 'Get a discount code by ID',
                    description: '**Admin JWT required.**',
                    operationId: 'getDiscountCodeById',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the discount code' },
                    ],
                    responses: {
                        '200': { description: 'Discount code', content: { 'application/json': { schema: { $ref: '#/components/schemas/DiscountCode' } } } },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                        '404': { description: 'Not found' },
                    },
                },
                put: {
                    tags: ['Discounts'],
                    summary: 'Update a discount code',
                    description: '**Admin JWT required.** Partial update — send only the fields you want to change.',
                    operationId: 'updateDiscountCode',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the discount code' },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/UpdateDiscountCodeRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Updated discount code', content: { 'application/json': { schema: { $ref: '#/components/schemas/DiscountCode' } } } },
                        '400': { description: 'Validation error' },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                        '404': { description: 'Not found' },
                    },
                },
                delete: {
                    tags: ['Discounts'],
                    summary: 'Delete a discount code',
                    description: '**Admin JWT required.** Permanently deletes the discount code.',
                    operationId: 'deleteDiscountCode',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the discount code' },
                    ],
                    responses: {
                        '200': { description: 'Deleted successfully' },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                        '404': { description: 'Not found' },
                    },
                },
            },
            '/api/discounts/users': {
                post: {
                    tags: ['Discounts'],
                    summary: 'Assign personal discount to a user',
                    description: '**Admin JWT required.** Assigns a percentage discount directly to a user\'s account. If the user already has a discount, it is **replaced**. When `isPermanent: false`, `expiresAt` is required and must be a future date.',
                    operationId: 'assignUserDiscount',
                    security: [{ BearerAuth: [] }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/AssignUserDiscountRequest' },
                            },
                        },
                    },
                    responses: {
                        '201': {
                            description: 'Discount assigned',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            message: { type: 'string', example: 'Discount assigned successfully' },
                                            data: { $ref: '#/components/schemas/UserDiscount' },
                                        },
                                    },
                                },
                            },
                        },
                        '400': { description: 'Validation error or invalid date' },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                    },
                },
                get: {
                    tags: ['Discounts'],
                    summary: 'List all users with assigned discounts',
                    description: '**Admin JWT required.**',
                    operationId: 'listUserDiscounts',
                    security: [{ BearerAuth: [] }],
                    responses: {
                        '200': {
                            description: 'List of user discounts',
                            content: {
                                'application/json': {
                                    schema: { type: 'array', items: { $ref: '#/components/schemas/UserDiscount' } },
                                },
                            },
                        },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                    },
                },
            },
            '/api/discounts/users/{userId}': {
                get: {
                    tags: ['Discounts'],
                    summary: 'Get a user\'s assigned discount',
                    description: '**Admin JWT required.**',
                    operationId: 'getUserDiscount',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { name: 'userId', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the user' },
                    ],
                    responses: {
                        '200': { description: 'User discount', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserDiscount' } } } },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                        '404': { description: 'No discount for this user' },
                    },
                },
                put: {
                    tags: ['Discounts'],
                    summary: 'Update a user\'s personal discount',
                    description: '**Admin JWT required.** Partial update.',
                    operationId: 'updateUserDiscount',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { name: 'userId', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the user' },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/UpdateUserDiscountRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Updated discount', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserDiscount' } } } },
                        '400': { description: 'Validation error' },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                        '404': { description: 'No discount for this user' },
                    },
                },
                delete: {
                    tags: ['Discounts'],
                    summary: 'Remove a user\'s personal discount',
                    description: '**Admin JWT required.** Permanently removes the user\'s assigned discount.',
                    operationId: 'deleteUserDiscount',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        { name: 'userId', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the user' },
                    ],
                    responses: {
                        '200': { description: 'Removed successfully' },
                        '401': { description: 'Unauthorized' },
                        '403': { description: 'Admin only' },
                        '404': { description: 'No discount for this user' },
                    },
                },
            },
            // ─── Notification Paths ───────────────────────────────────────────
            '/api/notifications/save-token': {
                post: {
                    tags: ['Notifications'],
                    summary: 'Save or update FCM device token',
                    description: 'Registers a new FCM token for a user. If the userId already exists, the token is updated.',
                    operationId: 'saveToken',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/SaveTokenRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Token saved or updated',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/SaveTokenResponse' } } },
                        },
                        '400': { description: 'Missing userId or token' },
                    },
                },
            },
            '/api/notifications/users': {
                get: {
                    tags: ['Notifications'],
                    summary: 'Get all registered users and tokens',
                    description: 'Returns the list of all users with their stored FCM tokens (admin use).',
                    operationId: 'getNotificationUsers',
                    responses: {
                        '200': {
                            description: 'List of users and tokens',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/GetUsersResponse' },
                                },
                            },
                        },
                    },
                },
            },
            '/api/notifications/send-to-user': {
                post: {
                    tags: ['Notifications'],
                    summary: 'Send notification to a single user',
                    description: 'Finds the user by `userId` and sends a push notification to their device. Invalid/unregistered tokens are automatically removed.',
                    operationId: 'sendToUser',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/SendToUserRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Notification sent' },
                        '400': { description: 'Missing required fields' },
                        '404': { description: 'User not found' },
                        '410': { description: 'Invalid token — token removed from DB' },
                        '500': { description: 'Notification failed' },
                    },
                },
            },
            '/api/notifications/send-to-all': {
                post: {
                    tags: ['Notifications'],
                    summary: 'Broadcast notification to all users',
                    description:
                        '**Requires `x-admin-key` header.** Sends the notification to all registered tokens using `sendEachForMulticast` in batches of up to **500** tokens (FCM limit). Invalid tokens are automatically cleaned up from the database.',
                    operationId: 'sendToAll',
                    parameters: [
                        {
                            name: 'x-admin-key',
                            in: 'header',
                            required: true,
                            schema: { type: 'string' },
                            description: 'Admin secret key (set as ADMIN_KEY in .env)',
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/BroadcastRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Broadcast result',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/BroadcastResponse' },
                                },
                            },
                        },
                        '400': { description: 'Missing title or body' },
                        '401': { description: 'Invalid or missing x-admin-key' },
                        '500': { description: 'Broadcast failed (e.g. Firebase not configured or internal error)' },
                    },
                },
            },
            '/api/notifications/delete-user/{userId}': {
                delete: {
                    tags: ['Notifications'],
                    summary: 'Delete a user token',
                    description: 'Removes the FCM token record for the given userId.',
                    operationId: 'deleteNotificationUser',
                    parameters: [
                        {
                            name: 'userId',
                            in: 'path',
                            required: true,
                            schema: { type: 'string' },
                            description: 'The userId whose token should be removed',
                        },
                    ],
                    responses: {
                        '200': { description: 'Token deleted successfully' },
                        '404': { description: 'User not found' },
                    },
                },
            },
            '/api/notifications/test-notify': {
                post: {
                    tags: ['Notifications'],
                    summary: 'Diagnostic Test Notification',
                    description: 'Diagnostic endpoint — checks Firebase, finds token, sends test notification. Returns step-by-step diagnostic info. Does not require admin key.',
                    operationId: 'testNotify',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['userId'],
                                    properties: {
                                        userId: { type: 'string', example: '65e39f18' },
                                        title: { type: 'string', example: '🔔 اختبار إشعار' },
                                        body: { type: 'string', example: 'الإشعارات تعمل بشكل صحيح ✅' },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Notification sent successfully' },
                        '400': { description: 'userId is required' },
                        '404': { description: 'No FCM token found for user' },
                        '500': { description: 'FCM send error or missing FIREBASE_SERVICE_ACCOUNT env var' },
                    },
                },
            },
            '/api/pricing/calculate-price': {
                post: {
                    tags: ['Pricing'],
                    summary: 'Calculate ride fare',
                    description: `**بدون توكين (Public).** Calculates the fare for a given distance. **Response \`price\` is in fils**. 1000 fils = 1 KD (e.g. 1000 = 1.000 KD, 500 = 0.500 KD, 50 = 0.050 KD).

**No minimum fare in this endpoint** — short distances return the exact fils (e.g. 20 m → 20 fils at 1 fil/m).

Internally (KD): \`total = (baseFare + distance_meters × pricePerMeter) × surgeMultiplier\`; then \`price = round(total × 1000)\` fils. Includes \`name_ar\`.`,
                    operationId: 'calculatePrice',
                    security: [],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CalculatePriceRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': { description: 'Calculated fare' },
                    },
                },
            },
            // ─── Representative Availability ────────────────────────────────
            '/api/users/{id}/availability': {
                patch: {
                    tags: ['Users'],
                    summary: 'Toggle representative availability',
                    description: [
                        '**JWT required.** Allows a user to toggle their online/offline availability status.',
                        '',
                        '- `isAvailable: true`  → المستخدم **متاح** ويستقبل طلبات جديدة.',
                        '- `isAvailable: false` → المستخدم **غير متاح** (فاصل التطبيق).',
                        '',
                        'The status is persisted in MongoDB (`isAvailable` field on the User document).',
                    ].join('\n'),
                    operationId: 'toggleRepresentativeAvailability',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            description: 'MongoDB _id of the representative user',
                            schema: { type: 'string', example: '507f1f77bcf86cd799439011' },
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['isAvailable'],
                                    properties: {
                                        isAvailable: {
                                            type: 'boolean',
                                            example: true,
                                            description: '`true` = online (accepting orders) | `false` = offline',
                                        },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Availability updated successfully',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            message: {
                                                type: 'string',
                                                example: 'You are now available and accepting orders',
                                            },
                                            userId: { type: 'string', example: '507f1f77bcf86cd799439011' },
                                            isAvailable: { type: 'boolean', example: true },
                                        },
                                    },
                                },
                            },
                        },
                        '400': { description: '`isAvailable` field is missing or not a boolean' },
                        '401': { description: 'JWT token missing or invalid' },
                        '404': { description: 'User not found' },
                    },
                },
            },

            // ─── Promote User to Representative ─────────────────────────────
            '/api/users/{id}/set-representative': {
                patch: {
                    tags: ['Users'],
                    summary: 'Promote user to Representative role',
                    description: [
                        '**Admin only (JWT required).** Sets `userType = "Representative"` on the target user.',
                        '',
                        'Call this endpoint **after** activating a user\'s account to mark them as a representative.',
                        'Once set, the user will appear in representative-filtered queries (`?userType=Representative`).',
                        '',
                        '**Flow:**',
                        '1. User submits an upgrade request via `POST /api/upgrade-request`.',
                        '2. Admin activates the account via `PUT /api/accounts/enable`.',
                        '3. Admin calls this endpoint to finalize the role promotion.',
                    ].join('\n'),
                    operationId: 'setUserAsRepresentative',
                    security: [{ BearerAuth: [] }],
                    parameters: [
                        {
                            name: 'id',
                            in: 'path',
                            required: true,
                            description: 'MongoDB _id of the user to promote',
                            schema: { type: 'string', example: '507f1f77bcf86cd799439011' },
                        },
                    ],
                    responses: {
                        '200': {
                            description: 'User promoted to Representative successfully',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            message: {
                                                type: 'string',
                                                example: 'User has been promoted to Representative',
                                            },
                                            userId: { type: 'string', example: '507f1f77bcf86cd799439011' },
                                            userType: { type: 'string', example: 'Representative' },
                                        },
                                    },
                                },
                            },
                        },
                        '401': { description: 'JWT token missing or invalid' },
                        '404': { description: 'User not found' },
                    },
                },
            },

        // ─────────────────────────────────────────────────────────────────────
        // RIDE TRACKING  (Google Routes API – route calculation + rerouting)
        // ─────────────────────────────────────────────────────────────────────
        '/api/trip/start': {
            post: {
                tags: ['Ride Tracking'],
                summary: 'Start a trip & get initial route',
                description: [
                    'Calculates a real road route from origin → destination using **Google Routes API v2**.',
                    'Returns an `encodedPolyline` that Flutter can decode and draw on Google Maps.',
                    '',
                    '**Side effects:**',
                    '- Stores trip state in Redis (TTL 24h)',
                    '- Joins the Socket.IO `/ride` trip room',
                    '- Drivers location updates will now be checked against this route for off-route detection',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['tripId', 'origin', 'destination'],
                                properties: {
                                    tripId: { type: 'string', example: 'trip_abc123', description: 'Unique trip ID (generated by client or order system)' },
                                    origin: {
                                        type: 'object',
                                        required: ['lat', 'lng'],
                                        properties: {
                                            lat: { type: 'number', example: 29.3759, description: 'Origin latitude' },
                                            lng: { type: 'number', example: 47.9774, description: 'Origin longitude' },
                                        },
                                    },
                                    destination: {
                                        type: 'object',
                                        required: ['lat', 'lng'],
                                        properties: {
                                            lat: { type: 'number', example: 29.3692, description: 'Destination latitude' },
                                            lng: { type: 'number', example: 47.9783, description: 'Destination longitude' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    '201': {
                        description: 'Trip started — initial route returned',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Trip started successfully' },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                tripId: { type: 'string', example: 'trip_abc123' },
                                                driverId: { type: 'string', example: '507f1f77bcf86cd799439011' },
                                                encodedPolyline: { type: 'string', example: 'cvc~Fg{uDzA...', description: 'Google encoded polyline — decode in Flutter with google_polyline_algorithm' },
                                                distanceMeters: { type: 'integer', example: 1420, description: 'Route distance in metres' },
                                                durationSeconds: { type: 'integer', example: 312, description: 'Estimated drive time in seconds' },
                                                status: { type: 'string', enum: ['active'], example: 'active' },
                                                startedAt: { type: 'string', format: 'date-time' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '400': { description: 'Validation error — invalid coordinates or missing fields' },
                    '401': { description: 'JWT missing or invalid' },
                    '429': { description: 'Rate limit exceeded' },
                },
            },
        },

        '/api/trip/end': {
            post: {
                tags: ['Ride Tracking'],
                summary: 'End an active trip',
                description: [
                    'Marks the trip as `completed` and emits a **`tripCompleted`** Socket.IO event',
                    'to all clients in the trip room (`trip:{tripId}`).',
                    '',
                    'Cleans up Redis trip state and off-route cooldown tracking.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['tripId'],
                                properties: {
                                    tripId: { type: 'string', example: 'trip_abc123' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    '200': {
                        description: 'Trip ended — tripCompleted event emitted',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                tripId: { type: 'string', example: 'trip_abc123' },
                                                status: { type: 'string', enum: ['completed'], example: 'completed' },
                                                completedAt: { type: 'string', format: 'date-time' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '401': { description: 'JWT missing or invalid' },
                    '403': { description: 'Driver does not own this trip' },
                    '404': { description: 'Trip not found' },
                },
            },
        },

        '/api/trip/{tripId}': {
            get: {
                tags: ['Ride Tracking'],
                summary: 'Get current trip state + polyline',
                description: 'Returns the current trip status, encoded polyline (updated if rerouted), distance, and duration.',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'tripId', in: 'path', required: true, schema: { type: 'string', example: 'trip_abc123' } },
                ],
                responses: {
                    '200': {
                        description: 'Trip state',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                tripId: { type: 'string' },
                                                driverId: { type: 'string' },
                                                origin: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
                                                destination: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
                                                encodedPolyline: { type: 'string', description: 'Current route polyline (updated when rerouted)' },
                                                distanceMeters: { type: 'integer', example: 1420 },
                                                durationSeconds: { type: 'integer', example: 312 },
                                                status: { type: 'string', enum: ['active', 'completed'] },
                                                startedAt: { type: 'string', format: 'date-time' },
                                                completedAt: { type: 'string', format: 'date-time', nullable: true },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '404': { description: 'Trip not found' },
                },
            },
        },

        '/api/driver/location': {
            post: {
                tags: ['Ride Tracking'],
                summary: 'Send live driver GPS location (every 5–10s)',
                description: [
                    '**Main location update endpoint.** Called by the driver app every 5–10 seconds.',
                    '',
                    '**Server pipeline:**',
                    '1. Validates lat/lng',
                    '2. Saves location to Redis (TTL 1h)',
                    '3. Emits **`driverLocationUpdated`** to trip Socket.IO room',
                    '4. Checks if driver deviated > **50 metres** from route',
                    '5. If off-route and cooldown (**20s**) expired → calls Google Routes API to reroute',
                    '6. If rerouted → emits **`routeUpdated`** with new `encodedPolyline`',
                    '',
                    '> ⚠️ Rate limited: max 30 requests/min per driver.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['tripId', 'lat', 'lng'],
                                properties: {
                                    tripId: { type: 'string', example: 'trip_abc123' },
                                    lat: { type: 'number', example: 29.3762, description: 'Driver latitude (-90 to 90)' },
                                    lng: { type: 'number', example: 47.9780, description: 'Driver longitude (-180 to 180)' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    '200': {
                        description: 'Location processed',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                tripId: { type: 'string' },
                                                isOffRoute: { type: 'boolean', example: false, description: 'Whether driver deviated > 50m from route' },
                                                rerouted: { type: 'boolean', example: false, description: 'Whether a new route was calculated' },
                                                distanceFromRoute: { type: 'integer', example: 12, description: 'Driver distance from route in metres' },
                                                cooldownActive: { type: 'boolean', example: false, description: 'If true, reroute was skipped due to 20s cooldown' },
                                                currentRoute: {
                                                    nullable: true,
                                                    description: 'New route data (only present when rerouted=true)',
                                                    type: 'object',
                                                    properties: {
                                                        encodedPolyline: { type: 'string' },
                                                        distanceMeters: { type: 'integer' },
                                                        durationSeconds: { type: 'integer' },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '400': { description: 'Invalid or missing lat/lng/tripId' },
                    '404': { description: 'Trip not found or not active' },
                    '429': { description: 'Rate limit — max 30 location updates/min' },
                },
            },
        },

        '/api/driver/{driverId}/location': {
            get: {
                tags: ['Ride Tracking'],
                summary: 'Get driver last known GPS position',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'driverId', in: 'path', required: true, schema: { type: 'string', example: '507f1f77bcf86cd799439011' } },
                ],
                responses: {
                    '200': {
                        description: 'Last known location',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                lat: { type: 'number', example: 29.3762 },
                                                lng: { type: 'number', example: 47.9780 },
                                                timestamp: { type: 'integer', example: 1716057600000, description: 'Unix timestamp (ms)' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '404': { description: 'No location found for this driver' },
                },
            },
        },

        // ─────────────────────────────────────────────────────────────────────
        // LIVE DRIVER TRACKING  (Socket.IO /tracking namespace – HTTP status only)
        // ─────────────────────────────────────────────────────────────────────
        '/api/tracking/driver/{driverId}/location': {
            get: {
                tags: ['Live Driver Tracking'],
                summary: 'Get driver last known GPS (Redis snapshot)',
                description: [
                    'Returns the last GPS position stored in Redis for this driver.',
                    '',
                    '**Use case:** Initial map load before Socket.IO connects.',
                    'After connecting, use Socket.IO `subscribeToTrip` for live updates instead.',
                    '',
                    '**Redis key:** `trk:driver:{driverId}:loc` (TTL 2 minutes)',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'driverId', in: 'path', required: true, schema: { type: 'string', example: '507f1f77bcf86cd799439011' } },
                ],
                responses: {
                    '200': {
                        description: 'Last known location snapshot',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                lat: { type: 'number', example: 29.3762 },
                                                lng: { type: 'number', example: 47.9780 },
                                                heading: { type: 'number', nullable: true, example: 90, description: 'Compass heading 0–360' },
                                                speed: { type: 'number', nullable: true, example: 45.5, description: 'Speed in km/h' },
                                                timestamp: { type: 'integer', example: 1716057600000, description: 'Unix timestamp ms' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '404': { description: 'No location data found (driver offline or TTL expired)' },
                },
            },
        },

        '/api/tracking/driver/{driverId}/status': {
            get: {
                tags: ['Live Driver Tracking'],
                summary: 'Get driver online/offline status',
                description: [
                    'Returns the driver\'s presence status from Redis.',
                    '`online` = driver sent a location update in the last 2 minutes.',
                    '`offline` = driver explicitly went offline.',
                    '`unknown` = no Redis record (never connected or TTL expired).',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'driverId', in: 'path', required: true, schema: { type: 'string', example: '507f1f77bcf86cd799439011' } },
                ],
                responses: {
                    '200': {
                        description: 'Driver status',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                driverId: { type: 'string', example: '507f1f77bcf86cd799439011' },
                                                status: { type: 'string', enum: ['online', 'offline', 'unknown'], example: 'online' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },

        '/api/tracking/stats': {
            get: {
                tags: ['Live Driver Tracking'],
                summary: 'Get system tracking stats (admin)',
                description: 'Returns the number of currently online drivers and their IDs. Sourced from Redis HSET `trk:online:drivers`.',
                security: [{ BearerAuth: [] }],
                responses: {
                    '200': {
                        description: 'Tracking system stats',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                onlineDrivers: { type: 'integer', example: 42, description: 'Number of currently online drivers' },
                                                driverIds: { type: 'array', items: { type: 'string' }, example: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439022'] },
                                                timestamp: { type: 'string', format: 'date-time' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },

        '/api/tracking/trip/{tripId}/drivers': {
            get: {
                tags: ['Live Driver Tracking'],
                summary: 'Get all driver IDs in a trip room',
                description: 'Returns the set of driverIds associated with this tripId in Redis (`trk:trip:{tripId}:drivers`).',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'tripId', in: 'path', required: true, schema: { type: 'string', example: 'trip_abc123' } },
                ],
                responses: {
                    '200': {
                        description: 'Driver IDs in trip',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                tripId: { type: 'string', example: 'trip_abc123' },
                                                driverIds: { type: 'array', items: { type: 'string' } },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },

        // ───────────────────────────────────────────────────────────────────
        // CHAT (real-time messaging with unread counts)
        // ───────────────────────────────────────────────────────────────────
        '/api/chat/{orderId}': {
            get: {
                tags: ['Chat'],
                summary: 'Get chat history for an order',
                description: [
                    'Returns messages for a specific order in chronological order.',
                    'Supports pagination via the `before` timestamp query param.',
                    '',
                    '**Live messages** arrive via Socket.IO `/chat` → event `receiveMessage` — do not poll this endpoint.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'orderId', in: 'path', required: true, schema: { type: 'string', example: 'order_abc123' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, example: 30 }, description: 'Max messages to return' },
                    { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time', example: '2026-05-18T20:00:00.000Z' }, description: 'Pagination cursor — returns messages older than this timestamp' },
                ],
                responses: {
                    '200': {
                        description: 'Chat history (chronological)',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    _id: { type: 'string', example: '6650f1a2b3c4d5e6f7a8b9c0' },
                                                    orderId: { type: 'string', example: 'order_abc123' },
                                                    senderId: { type: 'string', example: '507f1f77bcf86cd799439011' },
                                                    receiverId: { type: 'string', example: '507f1f77bcf86cd799439022' },
                                                    text: { type: 'string', example: 'Where are you now?' },
                                                    imageUrl: { type: 'string', nullable: true },
                                                    status: { type: 'string', enum: ['sent', 'delivered', 'read'], example: 'read' },
                                                    readAt: { type: 'string', format: 'date-time', nullable: true },
                                                    createdAt: { type: 'string', format: 'date-time' },
                                                    updatedAt: { type: 'string', format: 'date-time' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '401': { description: 'JWT missing or invalid' },
                },
            },
        },

        '/api/chat/{orderId}/unread': {
            get: {
                tags: ['Chat'],
                summary: 'Unread message count for one order',
                description: [
                    'Returns the count of unread messages **received by the authenticated user** in a specific order.',
                    'Use this to show a badge on the chat button inside the order card.',
                    '',
                    '> ⚡ Also available in real-time via Socket.IO event `unreadCount` — no need to poll.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'orderId', in: 'path', required: true, schema: { type: 'string', example: 'order_abc123' } },
                ],
                responses: {
                    '200': {
                        description: 'Unread count for this order',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                orderId: { type: 'string', example: 'order_abc123' },
                                                unreadCount: { type: 'integer', example: 3, description: 'Number of unread messages in this order for the current user' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '401': { description: 'JWT missing or invalid' },
                },
            },
        },

        '/api/chat/unread': {
            get: {
                tags: ['Chat'],
                summary: 'Total unread count across all orders (main badge)',
                description: [
                    'Returns the **total** number of unread messages for the authenticated user across **all orders**.',
                    'Also returns a per-order breakdown.',
                    '',
                    'Use `totalUnread` to show the main chat icon badge.',
                    'Use `byOrder` to show individual badges per order in the order list.',
                    '',
                    '> ⚡ Real-time updates arrive via Socket.IO event `unreadCount` after every `sendMessage` and `markAsRead`.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'orderId', in: 'query', required: false, schema: { type: 'string', example: 'order_abc123' }, description: 'Optional: filter to a single order' },
                ],
                responses: {
                    '200': {
                        description: 'Unread count summary',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                totalUnread: { type: 'integer', example: 7, description: 'Sum of all unread messages across all orders — use for main tab badge' },
                                                byOrder: {
                                                    type: 'array',
                                                    description: 'Per-order unread breakdown',
                                                    items: {
                                                        type: 'object',
                                                        properties: {
                                                            orderId: { type: 'string', example: 'order_abc123' },
                                                            count: { type: 'integer', example: 3 },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '401': { description: 'JWT missing or invalid' },
                },
            },
        },

        // ─────────────────────────────────────────────────────────────────────
        // CHAT  (real-time messaging + unread badge counts)
        // ─────────────────────────────────────────────────────────────────────

        '/api/chat/{orderId}': {
            get: {
                tags: ['Chat'],
                summary: 'Get chat history for an order',
                description: [
                    'Returns all messages for a specific order in chronological order.',
                    'Supports pagination via the `before` timestamp query param.',
                    '',
                    '> 💡 **Live messages** arrive via Socket.IO `/chat` → event `receiveMessage`. Do not poll this endpoint.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'orderId', in: 'path', required: true, schema: { type: 'string', example: 'order_abc123' }, description: 'The order ID' },
                    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50, example: 30 }, description: 'Max messages to return (default 50)' },
                    { name: 'before', in: 'query', required: false, schema: { type: 'string', format: 'date-time', example: '2026-05-18T20:00:00.000Z' }, description: 'Pagination: returns messages older than this timestamp' },
                ],
                responses: {
                    '200': {
                        description: 'Chat history in chronological order',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    _id:        { type: 'string', example: '6650f1a2b3c4d5e6f7a8b9c0' },
                                                    orderId:    { type: 'string', example: 'order_abc123' },
                                                    senderId:   { type: 'string', example: '507f1f77bcf86cd799439011' },
                                                    receiverId: { type: 'string', example: '507f1f77bcf86cd799439022' },
                                                    text:       { type: 'string', example: 'وين انت هلا؟' },
                                                    imageUrl:   { type: 'string', nullable: true, example: null },
                                                    status:     { type: 'string', enum: ['sent', 'delivered', 'read'], example: 'read' },
                                                    readAt:     { type: 'string', format: 'date-time', nullable: true },
                                                    createdAt:  { type: 'string', format: 'date-time' },
                                                    updatedAt:  { type: 'string', format: 'date-time' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '401': { description: 'JWT missing or invalid' },
                },
            },
        },

        '/api/chat/{orderId}/unread': {
            get: {
                tags: ['Chat'],
                summary: 'Unread count for one specific order',
                description: [
                    'Returns how many unread messages the **authenticated user** has in this order.',
                    '',
                    'Use this to show the red badge on the chat button of a specific order card.',
                    '',
                    '> ⚡ Real-time alternative: Socket.IO event `unreadCount.orderUnread` is pushed automatically — no need to poll.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'orderId', in: 'path', required: true, schema: { type: 'string', example: 'order_abc123' } },
                ],
                responses: {
                    '200': {
                        description: 'Unread count for this order',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                orderId:     { type: 'string',  example: 'order_abc123' },
                                                unreadCount: { type: 'integer', example: 3, description: 'Number of unread messages received by the current user in this order' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '401': { description: 'JWT missing or invalid' },
                },
            },
        },

        '/api/chat/unread': {
            get: {
                tags: ['Chat'],
                summary: 'Total unread count across all orders (main badge)',
                description: [
                    'Returns the **total** number of unread messages for the authenticated user across all orders.',
                    'Also returns a per-order breakdown.',
                    '',
                    '| Field | Usage |',
                    '|---|---|',
                    '| `totalUnread` | Badge on the main Chat tab icon |',
                    '| `byOrder[].count` | Badge on each order card in the order list |',
                    '',
                    '> ⚡ **Real-time:** Socket.IO `/chat` event `unreadCount` is pushed automatically after every `sendMessage` and `markAsRead` — you only need this HTTP endpoint on app startup.',
                ].join('\n'),
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'orderId', in: 'query', required: false, schema: { type: 'string', example: 'order_abc123' }, description: 'Optional: filter to one order only' },
                ],
                responses: {
                    '200': {
                        description: 'Total unread summary + per-order breakdown',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                totalUnread: {
                                                    type: 'integer',
                                                    example: 7,
                                                    description: 'Total unread messages across ALL orders — use for the main tab/icon badge',
                                                },
                                                byOrder: {
                                                    type: 'array',
                                                    description: 'Per-order breakdown — use to show badge on each order card',
                                                    items: {
                                                        type: 'object',
                                                        properties: {
                                                            orderId: { type: 'string',  example: 'order_abc123' },
                                                            count:   { type: 'integer', example: 3 },
                                                        },
                                                    },
                                                    example: [
                                                        { orderId: 'order_abc123', count: 3 },
                                                        { orderId: 'order_xyz789', count: 4 },
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    '401': { description: 'JWT missing or invalid' },
                },
            },
        },

        // ════════════════════════════════════════════════════════════════════
        // ⭐  User Ratings – POST & GET
        // ════════════════════════════════════════════════════════════════════

        '/api/ratings/order/{orderId}': {
            post: {
                tags: ['User Ratings'],
                summary: 'Submit a rating after order completion',
                description: [
                    'بعد اكتمال الأوردر (status = **completed**)، يمكن:',
                    '- **العميل** يقيّم **المندوب** (raterType: "client", rateeType: "representative")',
                    '- **المندوب** يقيّم **العميل** (raterType: "representative", rateeType: "client")',
                    '',
                    '### Rules',
                    '- الأوردر لازم يكون `completed`',
                    '- الـ raterId والـ rateeId لازم يكونوا مشاركين في الأوردر',
                    '- `raterType` و `rateeType` لازم يكونوا مختلفين',
                    '- تقييم واحد لكل اتجاه لكل أوردر (upsert — تحديث لو موجود)',
                ].join('\n'),
                parameters: [
                    {
                        name: 'orderId',
                        in: 'path',
                        required: true,
                        schema: { type: 'integer', minimum: 1, example: 42 },
                        description: 'Numeric order ID',
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/SubmitUserRatingRequest' },
                            examples: {
                                clientRatesRep: {
                                    summary: 'عميل يقيّم مندوب',
                                    value: {
                                        raterId:   '507f1f77bcf86cd799439011',
                                        raterType: 'client',
                                        rateeId:   '507f1f77bcf86cd799439022',
                                        rateeType: 'representative',
                                        rating:    5,
                                        comment:   'ممتاز وسريع جداً!',
                                    },
                                },
                                repRatesClient: {
                                    summary: 'مندوب يقيّم عميل',
                                    value: {
                                        raterId:   '507f1f77bcf86cd799439022',
                                        raterType: 'representative',
                                        rateeId:   '507f1f77bcf86cd799439011',
                                        rateeType: 'client',
                                        rating:    4,
                                        comment:   'عميل محترم ومتعاون',
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    '201': {
                        description: 'Rating submitted successfully',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitUserRatingResponse' } } },
                    },
                    '200': {
                        description: 'Rating updated (already existed, upserted)',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitUserRatingResponse' } } },
                    },
                    '400': { description: 'Validation error (missing fields, invalid rating value, or same raterType/rateeType)' },
                    '403': { description: 'Order not completed OR participant not in this order' },
                    '404': { description: 'Order not found' },
                },
            },

            get: {
                tags: ['User Ratings'],
                summary: 'Get all ratings for a specific order',
                description: 'يرجع كل تقييمات الأوردر في الاتجاهين (العميل → المندوب والمندوب → العميل).',
                parameters: [
                    {
                        name: 'orderId',
                        in: 'path',
                        required: true,
                        schema: { type: 'integer', minimum: 1, example: 42 },
                        description: 'Numeric order ID',
                    },
                ],
                responses: {
                    '200': {
                        description: 'Order ratings in both directions',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderRatingsResponse' } } },
                    },
                    '400': { description: 'Invalid orderId' },
                    '404': { description: 'Order not found' },
                },
            },
        },

        '/api/ratings/user/{userId}': {
            get: {
                tags: ['User Ratings'],
                summary: 'Get a user\'s ratings + average score',
                description: [
                    'أبعت `userId` (المُعرِّف MongoDB _id) وياخذلك:',
                    '- متوسط التقييم (`averageRating`)',
                    '- عدد التقييمات (`ratingCount`)',
                    '- عدد الطلبات المكتملة الفعلي (`completedOrdersCount`)',
                    '- توزيع النجوم 5★ → 1★ (`distribution`)',
                    '- قائمة التقييمات مع Pagination',
                ].join('\n'),
                parameters: [
                    {
                        name: 'userId',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', example: '507f1f77bcf86cd799439022' },
                        description: 'MongoDB _id of the user (client or representative)',
                    },
                    {
                        name: 'page',
                        in: 'query',
                        required: false,
                        schema: { type: 'integer', minimum: 1, default: 1, example: 1 },
                    },
                    {
                        name: 'limit',
                        in: 'query',
                        required: false,
                        schema: { type: 'integer', minimum: 1, maximum: 50, default: 20, example: 20 },
                    },
                ],
                responses: {
                    '200': {
                        description: 'User ratings list with stats',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/UserRatingsListResponse' } } },
                    },
                    '400': { description: 'userId is required' },
                },
            },
        },
        '/api/users/request-role': {
            post: {
                tags: ['Users'],
                summary: 'Request to become a Representative',
                security: [{ BearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateRoleRequest' } } },
                },
                responses: {
                    201: { description: 'Role request submitted successfully' },
                    400: { description: 'Bad request or already pending' },
                    401: { description: 'Unauthorized' }
                }
            }
        },
        '/api/users/role-requests': {
            get: {
                tags: ['Users'],
                summary: 'Get all role requests (Admin only)',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, required: false }
                ],
                responses: {
                    200: {
                        description: 'List of requests',
                        content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/RoleRequest' } } } }
                    },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden - Admins only' }
                }
            }
        },
        '/api/users/role-requests/{id}/status': {
            patch: {
                tags: ['Users'],
                summary: 'Update role request status (approve/reject)',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
                ],
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateRoleRequestStatus' } } },
                },
                responses: {
                    200: { description: 'Role request updated successfully' },
                    400: { description: 'Invalid status or already processed' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden - Admins only' },
                    404: { description: 'Role request not found' }
                }
            }
        },
        '/api/users/suspended': {
            get: {
                tags: ['Users'],
                summary: 'Get all suspended users (Admin only)',
                security: [{ BearerAuth: [] }],
                responses: {
                    200: {
                        description: 'List of suspended users',
                        content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
                    },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden – Admins only' },
                },
            },
        },
        '/api/users/suspend/{id}': {
            patch: {
                tags: ['Users'],
                summary: 'Suspend a user account (Admin only)',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the user to suspend' },
                ],
                responses: {
                    200: { description: 'User suspended successfully', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } } },
                    400: { description: 'User is already suspended' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden – Admins only' },
                    404: { description: 'User not found' },
                },
            },
        },
        '/api/users/unsuspend/{id}': {
            patch: {
                tags: ['Users'],
                summary: 'Unsuspend (activate) a user account (Admin only)',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the user to unsuspend' },
                ],
                responses: {
                    200: { description: 'User activated successfully', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } } },
                    400: { description: 'User is not suspended' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden – Admins only' },
                    404: { description: 'User not found' },
                },
            },
        },
        '/api/users/{id}/block': {
            put: {
                tags: ['Users'],
                summary: 'Block a user account completely (Admin only)',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the user to block' },
                ],
                responses: {
                    200: { description: 'User blocked successfully', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } } },
                    400: { description: 'User is already blocked' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden – Admins only' },
                    404: { description: 'User not found' },
                },
            },
        },
        '/api/users/{id}/unblock': {
            put: {
                tags: ['Users'],
                summary: 'Unblock a user account (Admin only)',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'MongoDB _id of the user to unblock' },
                ],
                responses: {
                    200: { description: 'User unblocked successfully', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } } },
                    400: { description: 'User is already active' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden – Admins only' },
                    404: { description: 'User not found' },
                },
            },
        },
        '/api/notifications/my-notifications': {
            get: {
                tags: ['Notifications'],
                summary: 'Get all notifications for the currently logged in user',
                security: [{ BearerAuth: [] }],
                responses: {
                    200: { description: 'Success', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
                    401: { description: 'Unauthorized' }
                }
            },
            delete: {
                tags: ['Notifications'],
                summary: 'Delete all notifications for the currently logged in user',
                security: [{ BearerAuth: [] }],
                responses: {
                    200: { description: 'All notifications deleted successfully' },
                    401: { description: 'Unauthorized' }
                }
            }
        },
        '/api/notifications/{id}': {
            delete: {
                tags: ['Notifications'],
                summary: 'Delete a specific notification by ID',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Notification ID' }
                ],
                responses: {
                    200: { description: 'Notification deleted successfully' },
                    401: { description: 'Unauthorized' },
                    404: { description: 'Notification not found' }
                }
            }
        },
        '/api/notifications/{id}/read': {
            patch: {
                tags: ['Notifications'],
                summary: 'Mark a specific notification as read',
                security: [{ BearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Notification ID' }
                ],
                responses: {
                    200: { description: 'Notification marked as read successfully' },
                    401: { description: 'Unauthorized' },
                    404: { description: 'Notification not found' }
                }
            }
        }
};

Object.assign(_swaggerPaths, {
    '/api/vehicle-types': {
        get: {
            summary: 'Get all vehicle types',
            tags: ['Vehicle Types'],
            parameters: [
                { in: 'query', name: 'active', schema: { type: 'string' }, description: 'Set to "true" to get only active vehicle types' }
            ],
            responses: { 200: { description: 'List of vehicle types' } }
        },
        post: {
            summary: 'Create a new vehicle type (Admin only)',
            tags: ['Vehicle Types'],
            security: [{ BearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['name_ar', 'baseFare', 'pricePerMeter', 'minFare'],
                            properties: {
                                name_ar: { type: 'string' },
                                name_en: { type: 'string' },
                                image: { type: 'string' },
                                baseFare: { type: 'number' },
                                pricePerMeter: { type: 'number' },
                                minFare: { type: 'number' },
                                isActive: { type: 'boolean' }
                            }
                        }
                    }
                }
            },
            responses: { 201: { description: 'Vehicle type created' } }
        }
    },
    '/api/vehicle-types/{id}': {
        put: {
            summary: 'Update a vehicle type (Admin only)',
            tags: ['Vehicle Types'],
            security: [{ BearerAuth: [] }],
            parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                name_ar: { type: 'string' },
                                name_en: { type: 'string' },
                                image: { type: 'string' },
                                baseFare: { type: 'number' },
                                pricePerMeter: { type: 'number' },
                                minFare: { type: 'number' },
                                isActive: { type: 'boolean' }
                            }
                        }
                    }
                }
            },
            responses: { 200: { description: 'Updated successfully' } }
        },
        delete: {
            summary: 'Delete a vehicle type (Admin only)',
            tags: ['Vehicle Types'],
            security: [{ BearerAuth: [] }],
            parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
            responses: { 200: { description: 'Deleted successfully' } }
        }
    },
    '/api/vehicle-types/calculate-price': {
        post: {
            summary: 'Calculate prices for all active vehicle types',
            tags: ['Vehicle Types'],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['distance_meters'],
                            properties: { distance_meters: { type: 'number' } }
                        }
                    }
                }
            },
            responses: { 200: { description: 'Calculated prices' } }
        }
    },
});
Object.assign(_swaggerPaths, {
    '/api/discounts/global-active': {
        get: {
            summary: 'Get the active global discount (Public/Client)',
            tags: ['Discounts'],
            parameters: [
                {
                    name: 'userId',
                    in: 'query',
                    required: false,
                    schema: { type: 'string' },
                    description: 'Client user ID to check eligibility if discount is one-time only'
                }
            ],
            responses: { 200: { description: 'Active global discount details' } }
        }
    },
    '/api/discounts/global': {
        get: {
            summary: 'Get global discount configuration (Admin)',
            tags: ['Discounts'],
            security: [{ BearerAuth: [] }],
            responses: { 200: { description: 'Global discount config' } }
        },
        put: {
            summary: 'Update global discount configuration (Admin)',
            tags: ['Discounts'],
            security: [{ BearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                discountPercentage: { type: 'number' },
                                isActive: { type: 'boolean' },
                                expiresAt: { type: 'string', format: 'date-time' },
                                isOneTimeOnly: { type: 'boolean' },
                                resetUsedUsers: { type: 'boolean' }
                            }
                        }
                    }
                }
            },
            responses: { 200: { description: 'Global discount updated' } }
        }
    },
});

const filteredPaths = {};
for (const [p, val] of Object.entries(_swaggerPaths)) {
    if (!p.startsWith('/api/store') && !p.startsWith('/api/agents') && !p.includes('/agent/')) {
        filteredPaths[p] = val;
    }
}
options.definition.paths = filteredPaths;

if (Array.isArray(options.definition.tags)) {
    options.definition.tags = options.definition.tags.filter(t => !/store|agent/i.test(t.name));
}

if (options.definition.components?.schemas) {
    for (const s of Object.keys(options.definition.components.schemas)) {
        if (/store|product|cart|favorite|agent|association|restaurant/i.test(s)) {
            delete options.definition.components.schemas[s];
        }
    }
}

module.exports = options.definition;










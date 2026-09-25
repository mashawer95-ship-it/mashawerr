/**
 * Order & task type definitions — single source of truth for enums used in MongoDB + validation.
 * انواع الاوردرات والتاسكات (مرجع واحد للداتابيز والـ API)
 */

/** حالات الأوردر في الحقل `Order.status` (نص في الداتابيز) */
const ORDER_STATUSES = Object.freeze([
    'waiting',
    'pending',
    'accepted',
    'delivering',
    'confirmed',
    'processing',
    'in_progress',
    'shipped',
    'delivered',
    'completed',
    'cancelled',
    'deleted',
    'review',
    'delayed',   // العميل تأخر في استلام الطلب — يُفعَّل من المندوب بعد انتهاء التايمر
    'return_pending',     // طلب استرجاع بانتظار قبول المندوب
    'return_accepted',    // تم قبول الاسترجاع من قِبل المندوب
    'return_delivering',  // المندوب استلم المرتجع من العميل وهو في الطريق للوكيل
    'returned',           // تم تسليم المرتجع للوكيل واكتمال الدورة
    'return_cancelled',   // تم إلغاء طلب الاسترجاع
]);

/** حالات كل تاسك داخل الأوردر `Order.tasks[].taskStatus` */
const TASK_STATUSES = Object.freeze(['pending', 'picked_up', 'completed']);

/** أنواع التاسك داخل الأوردر `Order.tasks[].type` */
const TASK_TYPES = Object.freeze(['purchase', 'delivery', 'passenger']);

/** تسميات عربية للمرجع (عرض / توثيق) */
const ORDER_STATUS_LABELS_AR = Object.freeze({
    waiting: 'انتظار',
    pending: 'قيد الانتظار',
    accepted: 'مقبول',
    delivering: 'جاري التوصيل',
    confirmed: 'مؤكد',
    processing: 'قيد التجهيز',
    in_progress: 'قيد التنفيذ',
    shipped: 'تم الشحن',
    delivered: 'تم التسليم',
    completed: 'مكتمل',
    cancelled: 'ملغي',
    deleted: 'محذوف',
    review: 'مراجعة',
    delayed: 'متأخر',   // العميل تأخر في الاستلام
    return_pending: 'مرتجع - بانتظار المندوب',
    return_accepted: 'مرتجع - تم القبول',
    return_delivering: 'مرتجع - جاري النقل',
    returned: 'مرتجع - مكتمل',
    return_cancelled: 'مرتجع - ملغي',
});

const TASK_TYPE_LABELS_AR = Object.freeze({
    purchase: 'مشتريات',
    delivery: 'توصيل',
});

module.exports = {
    ORDER_STATUSES,
    TASK_STATUSES,
    TASK_TYPES,
    ORDER_STATUS_LABELS_AR,
    TASK_TYPE_LABELS_AR,
};

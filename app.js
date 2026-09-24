// Mashawerr API Server Entrypoint - Password Reset & Email Verification Flow v2.0
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const os = require('os');
const https = require('https');
const http = require('http');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');
const { connectToDB, isDbReady } = require('./config/db');
const { notFound, errorHandler } = require('./middlewares/errors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
const { getRedisClient } = require('./config/redis');
const { registerRideSocket } = require('./sockets/rideSocket');
const { registerTrackingSocket } = require('./sockets/trackingSocket');
const { registerChatSocket } = require('./sockets/chatSocket');
const { registerHrSocket } = require('./sockets/hrSocket');
const { socketAuthMiddleware } = require('./middlewares/socketAuth');
const logger = require('./utils/logger');
const requestId = require('./middlewares/requestId');

// ── Global Process Error Handlers ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
    logger.error(`[UNCAUGHT_EXCEPTION] ${err.message}`, { stack: err.stack });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`[UNHANDLED_REJECTION] ${reason?.message || reason}`, {
        stack: reason?.stack || 'No stack trace available',
    });
});

const app = express();
const isDev = process.env.NODE_ENV !== 'production';

// ── Attach Request Correlation ID ───────────────────────────────────────────
app.use(requestId);

// ── Initialise Redis (non-blocking — logs error if unavailable) ──────────────
getRedisClient();

// Root + lightweight health for Render (must answer in < ~5s; no DB wait)
app.get('/', (req, res) => {
    res.status(200).json({ ok: true, service: 'mashawerr-api' });
});

// ── Security: Helmet (sets safe HTTP headers) ───────────────────────────────
app.use(helmet({
    // Allow images from any origin (needed for map tiles, Cloudinary, etc.)
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── HTTP request logging (Morgan → Winston) ──────────────────────────────────
app.use(morgan(isDev ? 'dev' : 'combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
}));

// CORS: allow any origin in development (for Flutter/mobile on same network)
app.use(cors({
    origin: isDev ? true : process.env.ALLOWED_ORIGIN || true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'token', 'x-api-key', 'x-admin-key'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// Static files: profile images at /uploads/...
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Swagger API docs (OpenAPI 3.0) – /api-docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
}));

// Health check – no DB required, used by keep-alive ping
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db: isDbReady() ? 'connected' : 'connecting' });
});

// Diagnostic endpoint to test live email sending configuration
app.all('/api/test-email', async (req, res) => {
    const to = req.query.to || req.body?.to || process.env.USER_EMAIL || 'amirrashraff1@gmail.com';
    const { sendEmail } = require('./services/emailService');
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
                brevoSenderEmail: process.env.BREVO_SENDER_EMAIL || process.env.USER_EMAIL || 'not_set',
                hasUserEmail: !!process.env.USER_EMAIL,
                hasUserPass: !!process.env.USER_PASS,
                hasSmtpHost: !!process.env.SMTP_HOST,
                hasResendApiKey: !!process.env.RESEND_API_KEY,
            },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            envConfig: {
                hasBrevoApiKey: !!process.env.BREVO_API_KEY,
                brevoSenderEmail: process.env.BREVO_SENDER_EMAIL || process.env.USER_EMAIL || 'not_set',
                hasUserEmail: !!process.env.USER_EMAIL,
                hasUserPass: !!process.env.USER_PASS,
                hasSmtpHost: !!process.env.SMTP_HOST,
                hasResendApiKey: !!process.env.RESEND_API_KEY,
            },
        });
    }
});

// ── ONE-TIME maintenance: drop unique index on storeOrderId ──────────────────
const mongoose = require('mongoose');
app.get('/api/maintenance/fix-order-index', async (req, res) => {
    try {
        const col = mongoose.connection.collection('storeorders');
        const indexes = await col.indexes();
        const target = indexes.find(i => i.key && i.key.storeOrderId !== undefined && i.unique);
        if (!target) {
            return res.json({ ok: true, message: 'No unique index on storeOrderId found – already clean.' });
        }
        await col.dropIndex(target.name);
        return res.json({ ok: true, message: `Index "${target.name}" dropped successfully.` });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});


// DB readiness – wait before /api/* (not / or /api/health). Keep under ~25s so clients get JSON 503 before some proxies return 502.
app.use('/api', async (req, res, next) => {
    if (isDbReady()) return next();

    const MAX_WAIT_MS = 25000;
    const POLL_MS = 500;
    let waited = 0;

    while (waited < MAX_WAIT_MS) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        waited += POLL_MS;
        if (isDbReady()) return next();
    }

    return res.status(503).json({
        message: 'Server is warming up, please try again in a few seconds.',
    });
});

// Register routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/pricing', require('./routes/pricing'));
app.use('/api/vehicle-types', require('./routes/vehicleTypes'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/v2/orders', require('./routes/orders'));
app.use('/api/orders/:orderId/tasks', require('./routes/tasks'));   // task pickup/deliver/photos
app.use('/api/ratings', require('./routes/ratings'));               // user ratings (client ↔ representative)
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/rep-commission', require('./routes/repCommission'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/feedback', require('./routes/feedback'));

// ─── Business / Store Module ────────────────────────────────────────────────
app.use('/api/store/agents', require('./routes/agents'));
app.use('/api/store/products', require('./routes/products'));
app.use('/api/store/cart', require('./routes/cart'));
app.use('/api/store/orders', require('./routes/storeOrders'));
app.use('/api/store/favorites', require('./routes/favorites'));
app.use('/api/store/associations', require('./routes/associations'));
app.use('/api/store/restaurants', require('./routes/restaurants'));
app.use('/api/store/pricing', require('./routes/storePricing'));

// ─── Wallet & Target System ───────────────────────────────────────────────────
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/rep-targets', require('./routes/repTargets'));

// ─── HR & Live Representative Tracking System ─────────────────────────────────
app.use('/api/hr', require('./routes/hr'));

// ─── Ride Tracking Module ─────────────────────────────────────────────────────
// POST /api/trip/start   → start trip & get initial route
// POST /api/trip/end     → end trip & emit tripCompleted
// GET  /api/trip/:tripId → get trip state
app.use('/api/trip', require('./routes/trip'));

// POST /api/driver/location          → receive live GPS (every 5-10s)
// GET  /api/driver/:driverId/location → last known position
app.use('/api/driver', require('./routes/driver'));

// Dummy endpoint for backward compatibility with old Flutter app code
app.post('/api/representative/location', (req, res) => {
    res.status(200).json({ success: true, message: 'Legacy endpoint ok. Please migrate to /api/trip/driver/location' });
});

// ─── Live Tracking Module (Socket.IO /tracking namespace) ────────────────────
// Status/admin REST queries only — live events are WebSocket-only
// GET /api/tracking/driver/:id/location → last known GPS
// GET /api/tracking/driver/:id/status   → online/offline
// GET /api/tracking/stats               → active driver count
app.use('/api/tracking', require('./routes/tracking'));

// ─── Real-time Chat Module ──────────────────────────────────────────────────
app.use('/api/chat', require('./routes/chat'));

// ─── Client Dynamic Configuration Module ───────────────────────────────────
app.use('/api/config', require('./routes/config'));

// ─── Static: uploaded order photos ──────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const { verifyTokenAndAdmin } = require('./middlewares/verifytoken');
app.get('/admin/route-metrics', verifyTokenAndAdmin, require('./Controllers/tripController').getRouteMetricsHandler);

// Static paths are already handled above by /uploads

// Error handling (must be after routes)
app.use(notFound);
app.use(errorHandler);

// ─── Create HTTP server + attach Socket.IO ───────────────────────────────────
const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
    cors: {
        origin: process.env.ALLOWED_SOCKET_ORIGINS
            ? process.env.ALLOWED_SOCKET_ORIGINS.split(',')
            : '*',
        methods: ['GET', 'POST'],
    },
    // WebSocket ONLY — eliminates HTTP long-polling which creates
    // 60+ requests/min per client under load. Flutter clients
    // now send JWT in the handshake so upgrading is safe.
    transports: ['websocket'],
    // Tuned for mobile clients (aggressive keep-alive)
    pingInterval: 25000,
    pingTimeout: 20000,
});

// ─── Socket.IO: Default namespace (order events) ─────────────────────────────
// Flutter client connects, then emits:
//   socket.emit('join_order', { orderId: '42' })
io.use(socketAuthMiddleware);

io.on('connection', (socket) => {
    logger.debug(`[Socket.IO] Client connected: ${socket.id} → user ${socket.user?.id}`);

    // Join a room for a specific order
    socket.on('join_order', async ({ orderId }) => {
        if (!orderId) return;

        // سكيورتي: تحقق إن المستخدم صاحب الطلب أو ممثل تسليم قبل إضافته للـ room
        try {
            const { Order } = require('./middlewares/Order');
            const order = await Order.findOne({ orderId: parseInt(orderId, 10) }).lean();

            if (!order) {
                logger.warn(`[Socket.IO] join_order rejected: order ${orderId} not found (socket: ${socket.id})`);
                return;
            }

            const userId = socket.user?.id;
            const userType = socket.user?.userType?.toLowerCase();
            const isAdmin = socket.user?.isAdmin;

            // المسموح لهم بالانضمام للـ room:
            // • العميل صاحب الطلب
            // • المندوب المعين للطلب
            // • الأدمين والإدارة
            const isOrderOwner  = order.userId?.toString()       === userId;
            const isAssignedRep = order.representativeId?.toString() === userId;
            const isStaff       = isAdmin || ['admin', 'administration', 'agent'].includes(userType);

            if (!isOrderOwner && !isAssignedRep && !isStaff) {
                logger.warn(`[Socket.IO] join_order DENIED: user ${userId} (${userType}) tried to join order ${orderId}`);
                socket.emit('error', { message: 'Access denied to this order room' });
                return;
            }
        } catch (err) {
            logger.error(`[Socket.IO] join_order auth check failed: ${err.message}`);
        }

        const room = `order:${orderId}`;
        socket.join(room);
        logger.debug(`[Socket.IO] ${socket.id} (user:${socket.user?.id}) joined room ${room}`);
        socket.emit('joined_order', { orderId, room });

        // 🔄 State Sync: If the client missed an event while disconnected/backgrounded,
        // send them the current status immediately upon joining.
        try {
            const { Order } = require('./middlewares/Order');
            const order = await Order.findOne({ orderId: parseInt(orderId, 10) }).lean();
            if (order && order.status) {
                // Emit only to this specific socket, not the whole room
                socket.emit('order:status_changed', {
                    orderId: order.orderId,
                    status: order.status,
                    message: 'State sync on connect'
                });
                logger.debug(`[Socket.IO] Synced state '${order.status}' for order ${orderId} to socket ${socket.id}`);
            }

            // Sync PoD Session state
            const { DeliverySession } = require('./models/DeliverySession');
            const session = await DeliverySession.findOne({ orderId }).lean();
            if (session && (session.subState === 'WAITING_OTP' || session.state === 'COMPLETED')) {
                socket.emit('delivery_session:approved', {
                    orderId,
                    sessionId: session.sessionId,
                    isApproved: true,
                    subState: session.subState,
                    otpVersion: session.otpVersion,
                    message: 'PoD State sync on connect'
                });
                socket.emit('order:pod_approved', {
                    orderId,
                    sessionId: session.sessionId,
                    isApproved: true,
                });
                logger.debug(`[Socket.IO] Synced PoD approved state for order ${orderId} to socket ${socket.id}`);
            }
        } catch (err) {
            logger.error(`[Socket.IO] Error syncing state for order ${orderId}: ${err.message}`);
        }
    });

    // Leave a room (cleanup)
    socket.on('leave_order', ({ orderId }) => {
        if (!orderId) return;
        const room = `order:${orderId}`;
        socket.leave(room);
        logger.debug(`[Socket.IO] ${socket.id} left room ${room}`);
    });

    // Join a user room (for global user events like PoD attempt_created)
    // SECURITY: كل يوزر يقدر يانضم لـ room بتاعته بس، مش بتاعة حد تاني
    socket.on('join_user', ({ userId }) => {
        if (!userId) return;

        // تحقق إن الـ userId المطلوب هو نفس المستخدم المتصل، إلا لو أدمين
        if (socket.user?.id !== userId && !socket.user?.isAdmin) {
            logger.warn(`[Socket.IO] join_user DENIED: user ${socket.user?.id} tried to join room of user ${userId}`);
            socket.emit('error', { message: 'Access denied to this user room' });
            return;
        }

        const room = `user:${userId}`;
        socket.join(room);
        logger.debug(`[Socket.IO] ${socket.id} joined room ${room}`);
    });

    // Leave a user room
    socket.on('leave_user', ({ userId }) => {
        if (!userId) return;
        const room = `user:${userId}`;
        socket.leave(room);
        logger.debug(`[Socket.IO] ${socket.id} left room ${room}`);
    });

    socket.on('disconnect', (reason) => {
        logger.debug(`[Socket.IO] Client disconnected: ${socket.id} — ${reason}`);
    });
});

// ─── Socket.IO: /ride namespace (route rerouting events) ───────────────────────
// Flutter connects to: ws://<host>/ride
registerRideSocket(io);

// ─── Socket.IO: /tracking namespace (live driver GPS tracking) ───────────────
// Zero Google API calls — pure coordinate relay at max 1 broadcast / 2s per driver
// Flutter driver app: ws://<host>/tracking  (emit: updateDriverLocation, joinTrip)
// Flutter customer app: ws://<host>/tracking (emit: subscribeToTrip)
registerTrackingSocket(io);

// ─── Socket.IO: /chat namespace (real-time messaging) ────────────────────────
// Flutter connects to: ws://<host>/chat
registerChatSocket(io);

// ─── Socket.IO: /hr namespace (real-time HR & tracking dashboard) ────────────
registerHrSocket(io);

// ─── Export io so controllers can emit events ────────────────────────────────
app.set('io', io);

// Start server
httpServer.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log(`Server running on port ${PORT}`);
    console.log(`  Local:   http://localhost:${PORT}`);
    if (localIP) console.log(`  Network: http://${localIP}:${PORT} (use this from your phone)`);
    console.log(`  Docs:    http://localhost:${PORT}/api-docs`);
    console.log(`  WS:      ws://${localIP || 'localhost'}:${PORT} (Socket.IO)`);
});

// Connect to DB after server is already listening
connectToDB().catch((err) => {
    console.error('DB connection failed:', err.message);
    process.exit(1);
});

// Keep-alive: ping the server every 8 minutes so Render never spins it down
const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.HOST || (process.env.NODE_ENV === 'production' ? 'https://mashawerr.onrender.com' : null);
if (renderUrl) {
    const PING_INTERVAL_MS = 8 * 60 * 1000;
    const pingUrl = `${renderUrl.replace(/\/$/, '')}/api/health`;

    setInterval(() => {
        const client = pingUrl.startsWith('https') ? https : http;
        client.get(pingUrl, (res) => {
            console.log(`Keep-alive ping → ${res.statusCode}`);
        }).on('error', (err) => {
            console.warn('Keep-alive ping failed:', err.message);
        });
    }, PING_INTERVAL_MS);

    console.log(`Keep-alive ping scheduled every 8 min → ${pingUrl}`);
}

/** Get first non-internal IPv4 address for console hint */
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) return iface.address;
        }
    }
    return null;
}

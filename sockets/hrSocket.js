/**
 * sockets/hrSocket.js
 * Real-time socket handlers for HR and live representative tracking.
 */

const { socketAuthMiddleware } = require('../middlewares/socketAuth');
const {
    touchRepAppState,
    setRepAppState,
    setRepSession,
    clearRepSession,
    getCachedLiveDashboard,
} = require('../redis/hrRedis');
const logger = require('../utils/logger');

/**
 * Register HR socket namespace `/hr` and add HR handlers to `/tracking`
 * @param {import('socket.io').Server} io
 */
function registerHrSocket(io) {
    const hrNsp = io.of('/hr');

    // Authenticate all socket connections to /hr
    hrNsp.use(socketAuthMiddleware);

    hrNsp.on('connection', (socket) => {
        const user = socket.user;
        logger.info(`[HrSocket] Connected to /hr: ${socket.id} user=${user?.id}`);

        // Admin joins live dashboard room
        socket.on('join_hr_dashboard', async () => {
            socket.join('hr:dashboard');
            logger.info(`[HrSocket] ${socket.id} joined hr:dashboard`);

            // Immediately send current live dashboard snapshot
            const dashboard = await getCachedLiveDashboard();
            if (dashboard) {
                socket.emit('hr:dashboard_snapshot', dashboard);
            }
        });

        socket.on('leave_hr_dashboard', () => {
            socket.leave('hr:dashboard');
        });

        socket.on('disconnect', (reason) => {
            logger.info(`[HrSocket] Client disconnected from /hr: ${socket.id} — ${reason}`);
        });
    });

    // ── Server Periodic Broadcast to /hr (every 30s) ────────────────
    setInterval(async () => {
        const dashboardSockets = hrNsp.adapter.rooms.get('hr:dashboard');
        if (!dashboardSockets || dashboardSockets.size === 0) return;

        try {
            const { getLiveTracking } = require('../Controllers/hrController');
            // Fetch fresh dashboard data (forcing refresh)
            const fakeReq = { query: { refresh: 'true' } };
            let dashboardData = null;
            const fakeRes = {
                json: (data) => { dashboardData = data; },
                status: () => fakeRes,
            };

            // Call handler directly to compute fresh snapshot
            await getLiveTracking(fakeReq, fakeRes, () => {});

            if (dashboardData) {
                hrNsp.to('hr:dashboard').emit('hr:dashboard_update', dashboardData);
            }
        } catch (err) {
            logger.error(`[HrSocket] Periodic dashboard broadcast error: ${err.message}`);
        }
    }, 30000);

    logger.info('[HrSocket] /hr socket namespace registered');
}

module.exports = { registerHrSocket };

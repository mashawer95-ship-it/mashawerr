import { createServer } from 'http';
import { app } from './presentation/http/app';
import { SocketGateway, locationRepository } from './presentation/sockets/gateway';
import { env } from './infrastructure/config/env';
import { logger } from './infrastructure/logger/pino-logger';

const httpServer = createServer(app);

// Initialize Socket.IO Gateway
const gateway = new SocketGateway(httpServer);

// Wire V5 Architecture Engines
import { setupV5Engines } from './infrastructure/di/dependencies';
import Redis from 'ioredis';

const engines = setupV5Engines(gateway.io);
const redisSub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redisSub.subscribe('trip:events', (err) => {
  if (err) logger.error({ err }, 'Failed to subscribe to trip:events channel');
  else logger.info('Subscribed to Redis channel: trip:events');
});

redisSub.on('message', async (channel, message) => {
  if (channel === 'trip:events') {
    try {
      const data = JSON.parse(message);
      if (data.event === 'order_accepted' && data.orderId) {
        logger.info(`[ORDER_ACCEPTED] Received order_accepted event for tripId: ${data.orderId}. Payload: ${JSON.stringify(data)}`);
        
        let driverLat = data.driverLat;
        let driverLng = data.driverLng;

        if ((driverLat == null || driverLng == null) && data.representativeId) {
          const driverLoc = await locationRepository.getDriverLocation(data.representativeId);
          if (driverLoc) {
            driverLat = driverLoc.latitude;
            driverLng = driverLoc.longitude;
            logger.info(`Fetched live location from memory for driver ${data.representativeId}: ${driverLat}, ${driverLng}`);
          }
        }

        if (driverLat == null || driverLng == null) {
          driverLat = data.originLat;
          driverLng = data.originLng;
          logger.warn(`No live location found for driver ${data.representativeId}, falling back to pickup location`);
        } else {
          logger.info(`Using driver location ${driverLat}, ${driverLng} to route to pickup ${data.originLat}, ${data.originLng}`);
        }

        // Trigger the V5 Lifecycle Engine to generate route!
        engines.lifecycleEngine.onOrderAccepted(
          String(data.orderId),
          driverLat,
          driverLng,
          data.originLat, // pickup Lat
          data.originLng  // pickup Lng
        );
      }
    } catch (e) {
      logger.error({ err: e }, 'Error parsing trip:events message');
    }
  }
});

const PORT = env.PORT || 3000;

httpServer.listen(PORT, () => {
  logger.info(`🚀 Tracking Service is running on port ${PORT} in ${env.NODE_ENV} mode`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received. Closing HTTP server.');
  httpServer.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
});

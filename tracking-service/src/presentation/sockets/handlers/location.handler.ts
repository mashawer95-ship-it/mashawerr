import { Server, Socket } from 'socket.io';
import { LocationUpdateSchema } from '../../../application/dtos/LocationUpdateDTO';
import { UpdateDriverLocationUseCase } from '../../../application/use-cases/UpdateDriverLocation';
import { logger } from '../../../infrastructure/logger/pino-logger';

// A simple in-memory rate limiter per driver.
const rateLimitMap = new Map<string, number>();

// Shared broadcast helper
function broadcastLocation(io: Server, payload: any) {
  const locationPayload = {
    driverId: payload.driverId || payload.d,
    orderId:  payload.orderId  || payload.tripId,
    location: payload.location || {
      lat:       payload.lat  ?? payload.la,
      lng:       payload.lng  ?? payload.ln,
      heading:   payload.heading ?? payload.h,
      speed:     payload.speed   ?? payload.s,
      timestamp: payload.timestamp ?? payload.t ?? Date.now(),
    },
    // flat fields for CustomerTrackingService fallback parsers
    lat:     payload.lat  ?? payload.la  ?? payload.location?.lat,
    lng:     payload.lng  ?? payload.ln  ?? payload.location?.lng,
    heading: payload.heading ?? payload.h ?? payload.location?.heading,
    timestamp: payload.timestamp ?? payload.t ?? Date.now(),
  };

  const orderId = locationPayload.orderId;
  if (!orderId) return;

  // Broadcast to order room (for CustomerTrackingService)
  io.to(`order:${orderId}`).emit('driverLocationUpdated', locationPayload);
  io.to(`order:${orderId}`).emit('driver:location:updated', locationPayload);
  // Also broadcast to trip room (for V5 tracking)
  io.to(`trip:${orderId}`).emit('driverLocationUpdated', locationPayload);

  io.in(`order:${orderId}`).fetchSockets().then(sockets => {
      logger.info(`[SOCKET_AUDIT_POSE] Namespace: /, Room: order:${orderId}, Connected Clients: ${sockets.length}, Socket IDs: ${sockets.map(s => s.id).join(', ')}`);
  });
  io.in(`trip:${orderId}`).fetchSockets().then(sockets => {
      logger.info(`[SOCKET_AUDIT_POSE] Namespace: /, Room: trip:${orderId}, Connected Clients: ${sockets.length}, Socket IDs: ${sockets.map(s => s.id).join(', ')}`);
  });

  logger.debug({ orderId, driverId: locationPayload.driverId }, 'Broadcasted location to order & trip rooms');
}

export const handleLocationEvents = (
  io: Server,
  socket: Socket,
  updateDriverLocationUseCase: UpdateDriverLocationUseCase
) => {
  // ─── V1: Driver App emits 'updateDriverLocation' (flat payload) ──────────────
  socket.on('updateDriverLocation', async (payload: any) => {
    try {
      const user = socket.data.user;
      // Rate limit
      const now = Date.now();
      const lastUpdate = rateLimitMap.get(user.userId) || 0;
      if (now - lastUpdate < 800) return;
      rateLimitMap.set(user.userId, now);

      broadcastLocation(io, payload);
    } catch (error) {
      logger.error(error, 'Failed to handle updateDriverLocation');
    }
  });

  // ─── V5: Driver App emits 'driver:location:update' (validated payload) ──────
  socket.on('driver:location:update', async (payload: unknown) => {
    try {
      const parsedPayload = LocationUpdateSchema.parse(payload);
      console.log(`[GPS_RECEIVED] driver:location:update received for driver ${parsedPayload.driverId}`);
      const user = socket.data.user;

      if (user.role !== 'driver' || user.userId !== parsedPayload.driverId) {
        socket.emit('error', { message: 'Unauthorized location update' });
        return;
      }

      const now = Date.now();
      const lastUpdate = rateLimitMap.get(user.userId) || 0;
      if (now - lastUpdate < 1000) return;
      rateLimitMap.set(user.userId, now);

      await updateDriverLocationUseCase.execute(parsedPayload);
      broadcastLocation(io, { ...parsedPayload, orderId: parsedPayload.orderId });
    } catch (error) {
      logger.error(error, 'Failed to handle driver:location:update');
      socket.emit('error', { message: 'Invalid payload or server error' });
    }
  });

  // ─── join_order: Customer joins order room ───────────────────────────────────
  socket.on('join_order', (data: any) => {
    const orderId = data?.orderId;
    if (orderId) {
      const room = `order:${orderId}`;
      socket.join(room);
      socket.emit('joined_order', { orderId, room });
      logger.debug({ socketId: socket.id, room }, 'Customer joined order room');
    }
  });
};

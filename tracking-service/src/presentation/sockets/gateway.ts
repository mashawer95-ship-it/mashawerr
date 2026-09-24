import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { socketAuthMiddleware } from './middlewares/auth.socket';
import { handleLocationEvents } from './handlers/location.handler';
import { UpdateDriverLocationUseCase } from '../../application/use-cases/UpdateDriverLocation';
import { MemoryLocationRepository } from '../../infrastructure/persistence/MemoryLocationRepository';
import { logger } from '../../infrastructure/logger/pino-logger';

// Dependency Injection Setup
export const locationRepository = new MemoryLocationRepository();
const updateDriverLocationUseCase = new UpdateDriverLocationUseCase(locationRepository);

export class SocketGateway {
  public io: Server;

  constructor(server: HttpServer) {
    this.io = new Server(server, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
      },
      pingInterval: 10000,
      pingTimeout: 5000,
    });

    this.setupMiddlewares();
    this.setupEventHandlers();
  }

  private setupMiddlewares() {
    this.io.use(socketAuthMiddleware);
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket: Socket) => {
      const user = socket.data.user;
      logger.info({ socketId: socket.id, userId: user.userId, role: user.role }, 'New socket connected');

      // Join rooms based on role
      if (user.role === 'driver') {
        const driverRoom = `driver:${user.userId}`;
        socket.join(driverRoom);
        logger.debug({ socketId: socket.id, room: driverRoom }, 'Driver joined room');
      } else if (user.role === 'customer' && user.orderId) {
        const orderRoom = `order:${user.orderId}`;
        socket.join(orderRoom);
        logger.debug({ socketId: socket.id, room: orderRoom }, 'Customer joined room');
      }

      // Handle custom join room requests (e.g., driver starting a new order)
      socket.on('join:room', (room: string) => {
        // Here you would add additional authorization to prevent arbitrary room joins
        if (room.startsWith('order:') || room.startsWith('driver:')) {
          socket.join(room);
          logger.debug({ socketId: socket.id, room }, 'Socket joined room manually');
        } else {
          socket.emit('error', { message: 'Unauthorized to join this room' });
        }
      });

      // Handle V5 Tracking join request from Flutter App
      socket.on('join_trip', async (data: any) => {
        const tripId = data?.tripId;
        if (tripId) {
          const room = `trip:${tripId}`;
          const socketsBefore = await this.io.in(room).fetchSockets();
          const membersBefore = socketsBefore.length;
          
          socket.join(room);
          
          const socketsAfter = await this.io.in(room).fetchSockets();
          const membersAfter = socketsAfter.length;

          console.log(`[CLIENT_JOIN] socket: ${socket.id}, tripId: ${tripId}, room: ${room}, members_before: ${membersBefore}, members_after: ${membersAfter}`);
          logger.debug({ socketId: socket.id, room }, 'Socket joined trip room via join_trip');
          // send dummy subscribed event to notify Flutter
          socket.emit('subscribed', { tripId, hasLocation: false });
        }
      });

      // Register Handlers
      handleLocationEvents(this.io, socket, updateDriverLocationUseCase);

      socket.on('disconnect', (reason) => {
        logger.info({ socketId: socket.id, reason }, 'Socket disconnected');
      });
    });
  }
}

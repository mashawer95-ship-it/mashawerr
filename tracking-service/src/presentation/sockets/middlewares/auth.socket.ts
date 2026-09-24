import { Socket } from 'socket.io';
import { JwtService } from '../../../infrastructure/security/JwtService';
import { logger } from '../../../infrastructure/logger/pino-logger';

export const socketAuthMiddleware = (socket: Socket, next: (err?: any) => void) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      logger.warn('Socket connection attempt without token');
      return next(new Error('Authentication error: Token missing'));
    }

    const payload = JwtService.verifyToken(token);
    
    // Attach user data to socket
    socket.data.user = payload;
    
    logger.info({ userId: payload.userId, role: payload.role }, 'Socket authenticated successfully');
    next();
  } catch (error) {
    logger.error(error, 'Socket authentication failed');
    next(new Error('Authentication error: Invalid token'));
  }
};

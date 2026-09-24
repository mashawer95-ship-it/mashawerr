import { TripEventBus } from '../../application/events/TripEventBus';
import { VersionService } from '../../application/services/VersionService';
import { TripLifecycleEngine } from '../../domain/engines/TripLifecycleEngine';
import { RouteCoordinator } from '../../domain/engines/RouteCoordinator';
import { RoutingEngine } from '../../domain/engines/RoutingEngine';
import { GoogleRouteProvider } from '../../application/interfaces/GoogleRouteProvider';
import { MapMatchingEngine } from '../../domain/engines/MapMatchingEngine';
import { DeviationEngine } from '../../domain/engines/DeviationEngine';
import { RedisTripRouteStore } from '../persistence/RedisTripRouteStore';
import { TripBroadcastService } from '../../application/services/TripBroadcastService';
import { ISocketGateway } from '../../application/services/TripBroadcastService';
import { Server } from 'socket.io';
import { logger } from '../logger/pino-logger';
import { env } from '../config/env';

export interface V5Engines {
  eventBus: TripEventBus;
  lifecycleEngine: TripLifecycleEngine;
  broadcastService: TripBroadcastService;
  mapMatchingEngine: MapMatchingEngine;
}

export function setupV5Engines(io: Server): V5Engines {
  logger.info('Initializing V5 Tracking Architecture Engines...');

  // 1. Core Event Bus & Store
  const eventBus = new TripEventBus();
  const routeStore = new RedisTripRouteStore();
  
  // 2. Providers & Services
  const versionService = new VersionService(routeStore);
  const routeProvider = new GoogleRouteProvider();
  
  // 3. Calculation Engines
  const routingEngine = new RoutingEngine(routeProvider, versionService);
  
  // 4. Coordinators
  const routeCoordinator = new RouteCoordinator(
    eventBus,
    routingEngine,
    routeStore
  );
  
  // 5. Lifecycle
  const lifecycleEngine = new TripLifecycleEngine(eventBus);
  
  // 6. Real-time matching
  const deviationEngine = new DeviationEngine(eventBus);
  const mapMatchingEngine = new MapMatchingEngine(deviationEngine, routeStore);
  
  // 7. Broadcaster (Adapter for Socket.io)
  const socketAdapter: ISocketGateway = {
    toRoom: (room: string) => {
      return {
        emit: (event: string, data: any) => {
          io.in(room).fetchSockets().then(sockets => {
             const payloadStr = JSON.stringify(data);
             console.log(`[EMIT_ROUTE] namespace: /, room: ${room}, clients: ${sockets.length}, event: ${event}, payload_size: ${payloadStr.length} bytes`);
             io.to(room).emit(event, data);
          }).catch(err => {
             console.error(`[EMIT_ROUTE] Error fetching sockets for room ${room}:`, err);
             io.to(room).emit(event, data);
          });
        }
      };
    }
  };
  const broadcastService = new TripBroadcastService(eventBus, socketAdapter);

  logger.info('V5 Tracking Architecture Engines Initialized Successfully');

  return {
    eventBus,
    lifecycleEngine,
    broadcastService,
    mapMatchingEngine
  };
}

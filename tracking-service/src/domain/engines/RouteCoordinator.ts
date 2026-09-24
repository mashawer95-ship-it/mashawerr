import { TripEventBus } from '../../application/events/TripEventBus';
import { GenerateRouteCommand, RouteGeneratedEvent } from '../entities/CommandsEvents';
import { RoutingEngine } from './RoutingEngine';
import { TripRouteStore } from '../repositories/TripRouteStore';

/**
 * The Orchestrator that bridges Commands to the RoutingEngine,
 * and handles the resulting RouteSnapshot (saving to Redis, broadcasting).
 */
export class RouteCoordinator {
  constructor(
    private eventBus: TripEventBus,
    private routingEngine: RoutingEngine,
    private routeStore: TripRouteStore
  ) {
    this.setupListeners();
  }

  private setupListeners(): void {
    // 1. Listen for GenerateRouteCommand
    this.eventBus.onCommand('GenerateRouteCommand', async (command: GenerateRouteCommand) => {
      try {
        console.log(`[ROUTE_COORDINATOR] Received GenerateRouteCommand for trip ${command.tripId}. Calling RoutingEngine...`);
        const snapshot = await this.routingEngine.generateRoute(command);
        
        if (snapshot) {
          console.log(`[SNAPSHOT_CREATED] Snapshot created successfully for trip ${command.tripId}. Snapshot length: ${snapshot.encodedPolyline.length}`);
          // 2. Fire RouteGeneratedEvent internally
          this.eventBus.emitRouteGenerated({
            tripId: command.tripId,
            snapshot
          });
        }
      } catch (error) {
        console.error(`[RouteCoordinator] Failed to generate route for trip ${command.tripId}:`, error);
      }
    });

    // 3. Listen for RouteGeneratedEvent to coordinate side-effects
    this.eventBus.onRouteGenerated(async (event: RouteGeneratedEvent) => {
      console.log(`[REDIS_ROUTE] Event bus received RouteGeneratedEvent for trip ${event.tripId}. Saving to Redis...`);
      // Store in Redis (Split keys)
      await this.routeStore.saveRouteSnapshot(event.tripId, event.snapshot);
      console.log(`[REDIS_ROUTE] Successfully saved route snapshot to Redis for trip ${event.tripId}`);
      // Additional side effects like Update ETA, etc. can go here
    });
  }
}

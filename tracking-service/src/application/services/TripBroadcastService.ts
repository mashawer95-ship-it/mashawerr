import { TripEventBus } from '../events/TripEventBus';
import { DriverPose, MotionState } from '../../domain/entities/DriverPose';
import { RouteSnapshot } from '../../domain/entities/RouteSnapshot';

export interface ISocketGateway {
  toRoom(room: string): {
    emit(event: string, data: any): void;
  };
}

/**
 * TripBroadcastService listens to the Event Bus and broadcasts to Socket.IO.
 * Implements Diff Only and Adaptive Rate logic.
 */
export class TripBroadcastService {
  private lastBroadcastMap = new Map<string, number>();

  constructor(
    private eventBus: TripEventBus,
    private socketGateway: ISocketGateway
  ) {
    this.setupListeners();
  }

  private setupListeners(): void {
    // Listen to Poses (Diff Only + Adaptive Rate)
    this.eventBus.onPose((pose: DriverPose) => {
      if (this.shouldBroadcastPose(pose)) {
        this.lastBroadcastMap.set(pose.tripId, Date.now());
        
        console.log(`[BROADCAST_POSE] Broadcasting pose for trip: ${pose.tripId} to room trip:${pose.tripId}`);
        // Diff Only: We only broadcast the Pose, not the polyline
        this.socketGateway.toRoom(`trip:${pose.tripId}`).emit('trip.driver.location', pose);
        this.socketGateway.toRoom(`trip:${pose.tripId}`).emit('driverLocationUpdated', pose); // TEMP FIX FOR FLUTTER
        console.log(`[ROOM_CUSTOMERS] Emitted trip.driver.location and driverLocationUpdated to room trip:${pose.tripId}`);
      }
    });

    // Listen to Route Updates (Full Route Update)
    this.eventBus.onRouteGenerated(({ tripId, snapshot }) => {
      console.log(`[BROADCAST_ROUTE] tripId: ${tripId}, version: ${snapshot.version}, room: trip:${tripId}`);
      // Diff Only: When route changes, we broadcast the full Route Update
      this.socketGateway.toRoom(`trip:${tripId}`).emit('trip.route.updated', {
        encodedPolyline: snapshot.encodedPolyline
      });
      console.log(`[ROOM_CUSTOMERS] Emitted trip.route.updated to room trip:${tripId}`);
    });
  }

  /**
   * Adaptive Rate Logic to save massive bandwidth.
   */
  private shouldBroadcastPose(pose: DriverPose): boolean {
    const lastBroadcast = this.lastBroadcastMap.get(pose.tripId) || 0;
    const now = Date.now();
    const elapsed = now - lastBroadcast;

    switch (pose.motionState) {
      case MotionState.STOPPED:
        return elapsed >= 3000; // 3 seconds
      case MotionState.TURNING:
        return elapsed >= 300;  // 300 ms
      case MotionState.HIGH_SPEED:
        return elapsed >= 500;  // 500 ms
      case MotionState.MOVING:
      default:
        return elapsed >= 1000; // 1 second
    }
  }
}

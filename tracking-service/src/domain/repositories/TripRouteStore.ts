import { RouteSnapshot } from '../entities/RouteSnapshot';
import { DriverPose } from '../entities/DriverPose';

export interface TripState {
  status: string;
  driverId?: string;
  updatedAt: number;
}

export interface TripRouteStore {
  // Snapshot Key
  saveRouteSnapshot(tripId: string, snapshot: RouteSnapshot): Promise<void>;
  getRouteSnapshot(tripId: string): Promise<RouteSnapshot | null>;
  
  // Pose Key
  savePoseHistory(tripId: string, pose: DriverPose): Promise<void>;
  getPoseHistory(tripId: string): Promise<DriverPose[]>;
  
  // ETA Key
  saveETA(tripId: string, etaSeconds: number, distanceMeters: number): Promise<void>;
  getETA(tripId: string): Promise<{etaSeconds: number, distanceMeters: number} | null>;
  
  // State Key
  saveTripState(tripId: string, state: TripState): Promise<void>;
  getTripState(tripId: string): Promise<TripState | null>;
}

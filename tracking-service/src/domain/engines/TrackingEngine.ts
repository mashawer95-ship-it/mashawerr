import { DriverPose } from '../entities/DriverPose';
import { PoseEngine } from './PoseEngine';

/**
 * TrackingEngine receives Raw GPS from devices and pipes it into the pipeline.
 */
export class TrackingEngine {
  constructor(private poseEngine: PoseEngine) {}

  public async processRawGps(
    tripId: string,
    driverId: string,
    rawLat: number,
    rawLng: number,
    heading: number,
    speed: number,
    accuracy: number
  ): Promise<void> {
    // 1. Basic validation
    if (!this.isValidGps(rawLat, rawLng)) return;

    // 2. Pipe to Pose Engine
    await this.poseEngine.processPose({
      tripId,
      driverId,
      rawLat,
      rawLng,
      heading,
      speed,
      accuracy,
      timestamp: Date.now(),
    });
  }

  private isValidGps(lat: number, lng: number): boolean {
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }
}

import { DriverPose, MotionState, HeadingSource } from '../entities/DriverPose';
import { MapMatchingEngine } from './MapMatchingEngine';

/**
 * PoseEngine enriches raw GPS with motion states, heading quality, and pipes it to Map Matching.
 */
export class PoseEngine {
  constructor(private mapMatchingEngine: MapMatchingEngine) {}

  public async processPose(rawInput: any): Promise<void> {
    const motionState = rawInput.speed > 0.5 ? MotionState.MOVING : MotionState.STOPPED;

    const partialPose: Partial<DriverPose> = {
      ...rawInput,
      motionState,
      headingSource: HeadingSource.GPS,
      headingQuality: rawInput.accuracy < 10 ? 'high' : 'medium',
      gpsAge: 0,
    };

    await this.mapMatchingEngine.match(partialPose as DriverPose);
  }
}

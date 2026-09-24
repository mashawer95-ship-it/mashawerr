export enum MotionState {
  STOPPED = 'stopped',
  MOVING = 'moving',
  TURNING = 'turning',
  HIGH_SPEED = 'high_speed',
}

export enum HeadingSource {
  GPS = 'gps',
  ROTATION_VECTOR = 'rotation_vector',
  GYROSCOPE = 'gyroscope',
}

export interface DriverPose {
  tripId: string;
  driverId: string;
  rawLat: number;
  rawLng: number;
  matchedLat: number;
  matchedLng: number;
  heading: number;
  bearing: number;
  speed: number;
  accuracy: number;
  verticalAccuracy: number;
  motionState: MotionState;
  gpsAge: number;
  headingSource: HeadingSource;
  headingQuality: 'low' | 'medium' | 'high';
  timestamp: number;
  routeVersion: number;
}

import { TripRouteStore, TripState } from '../../domain/repositories/TripRouteStore';
import { RouteSnapshot } from '../../domain/entities/RouteSnapshot';
import { DriverPose } from '../../domain/entities/DriverPose';
import Redis from 'ioredis';
import { logger } from '../logger/pino-logger';
import { env } from '../config/env';

export class RedisTripRouteStore implements TripRouteStore {
  private redis: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
    });
    
    this.redis.on('error', (err) => logger.error({ err }, 'RedisTripRouteStore connection error'));
    this.redis.on('connect', () => logger.info('RedisTripRouteStore connected to Redis'));
  }

  // Snapshot Key
  async saveRouteSnapshot(tripId: string, snapshot: RouteSnapshot): Promise<void> {
    const key = `trip:${tripId}:snapshot`;
    // Store snapshot for 24 hours
    await this.redis.setex(key, 86400, JSON.stringify(snapshot));
  }

  async getRouteSnapshot(tripId: string): Promise<RouteSnapshot | null> {
    const key = `trip:${tripId}:snapshot`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) as RouteSnapshot : null;
  }

  // Pose Key (We only keep the latest pose to save memory)
  async savePoseHistory(tripId: string, pose: DriverPose): Promise<void> {
    const key = `trip:${tripId}:pose`;
    // Store pose for 1 hour
    await this.redis.setex(key, 3600, JSON.stringify(pose));
  }

  async getPoseHistory(tripId: string): Promise<DriverPose[]> {
    const key = `trip:${tripId}:pose`;
    const data = await this.redis.get(key);
    return data ? [JSON.parse(data) as DriverPose] : [];
  }

  // ETA Key
  async saveETA(tripId: string, etaSeconds: number, distanceMeters: number): Promise<void> {
    const key = `trip:${tripId}:eta`;
    await this.redis.setex(key, 3600, JSON.stringify({ etaSeconds, distanceMeters }));
  }

  async getETA(tripId: string): Promise<{ etaSeconds: number; distanceMeters: number; } | null> {
    const key = `trip:${tripId}:eta`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  // State Key
  async saveTripState(tripId: string, state: TripState): Promise<void> {
    const key = `trip:${tripId}:state`;
    await this.redis.setex(key, 86400, JSON.stringify(state));
  }

  async getTripState(tripId: string): Promise<TripState | null> {
    const key = `trip:${tripId}:state`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) as TripState : null;
  }
}

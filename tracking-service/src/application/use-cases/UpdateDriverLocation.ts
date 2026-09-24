import { ILocationRepository } from '../../domain/repositories/ILocationRepository';
import { LocationUpdateDTO } from '../dtos/LocationUpdateDTO';
import { logger } from '../../infrastructure/logger/pino-logger';

export class UpdateDriverLocationUseCase {
  constructor(private locationRepository: ILocationRepository) {}

  async execute(dto: LocationUpdateDTO): Promise<void> {
    // Check if the driver is authorized for this order.
    // In a real application, you might query an OrderRepository to verify ownership.
    // For this demonstration, we assume verification happens at the socket connection and payload validation level.
    
    logger.debug({ driverId: dto.driverId, orderId: dto.orderId }, 'Executing update driver location use case');
    console.log(`[POSE_CREATED] Location update use case executed for driver ${dto.driverId}`);

    await this.locationRepository.updateDriverLocation(dto.driverId, dto.location);
    
    // The use case just updates the persistence. 
    // The Socket gateway will handle the broadcasting to ensure separation of concerns.
  }
}

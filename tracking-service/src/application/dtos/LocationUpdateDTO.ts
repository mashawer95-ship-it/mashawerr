import { z } from 'zod';

export const LocationUpdateSchema = z.object({
  driverId: z.string().uuid().or(z.string().min(1)),
  orderId: z.string().uuid().or(z.string().min(1)),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    heading: z.number().min(0).max(360).optional(),
    timestamp: z.number().positive(),
  }),
});

export type LocationUpdateDTO = z.infer<typeof LocationUpdateSchema>;

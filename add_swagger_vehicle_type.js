const fs = require('fs');
const path = require('path');

const swaggerPath = path.join(__dirname, 'config', 'swagger.js');
let swaggerContent = fs.readFileSync(swaggerPath, 'utf8');

// 1. Add schemas
const schemasToAdd = `
                VehicleType: {
                    type: 'object',
                    properties: {
                        _id: { type: 'string' },
                        name_ar: { type: 'string' },
                        name_en: { type: 'string' },
                        image: { type: 'string' },
                        baseFare: { type: 'number', description: 'Base fare in fils' },
                        baseFare_name_ar: { type: 'string' },
                        pricePerMeter: { type: 'number', description: 'Price per meter in fils' },
                        pricePerMeter_name_ar: { type: 'string' },
                        minFare: { type: 'number', description: 'Minimum fare in fils' },
                        minFare_name_ar: { type: 'string' },
                        surgeMultiplier: { type: 'number', description: 'Surge multiplier' },
                        isActive: { type: 'boolean' },
                    }
                },
`;
if (!swaggerContent.includes('VehicleType: {')) {
    // Insert before "RoleRequest: {"
    swaggerContent = swaggerContent.replace("RoleRequest: {", schemasToAdd + "                RoleRequest: {");
}

// 2. Add Paths
const pathsToAdd = `
    '/api/vehicle-types': {
        get: {
            summary: 'Get all vehicle types',
            tags: ['Vehicle Types'],
            parameters: [
                { in: 'query', name: 'active', schema: { type: 'string' }, description: 'Set to "true" to get only active vehicle types' }
            ],
            responses: { 200: { description: 'List of vehicle types' } }
        },
        post: {
            summary: 'Create a new vehicle type (Admin only)',
            tags: ['Vehicle Types'],
            security: [{ BearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'multipart/form-data': {
                        schema: {
                            type: 'object',
                            required: ['name_ar'],
                            properties: {
                                name_ar: { type: 'string' },
                                name_en: { type: 'string' },
                                image: { type: 'string', format: 'binary', description: 'Upload vehicle image file' },
                                baseFare: { type: 'number' },
                                pricePerMeter: { type: 'number' },
                                minFare: { type: 'number' },
                                surgeMultiplier: { type: 'number' },
                                isActive: { type: 'boolean' }
                            }
                        }
                    }
                }
            },
            responses: { 201: { description: 'Vehicle type created' } }
        }
    },
    '/api/vehicle-types/{id}': {
        put: {
            summary: 'Update a vehicle type (Admin only)',
            tags: ['Vehicle Types'],
            security: [{ BearerAuth: [] }],
            parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
            requestBody: {
                required: true,
                content: {
                    'multipart/form-data': {
                        schema: {
                            type: 'object',
                            properties: {
                                name_ar: { type: 'string' },
                                name_en: { type: 'string' },
                                image: { type: 'string', format: 'binary', description: 'Upload vehicle image file' },
                                baseFare: { type: 'number' },
                                pricePerMeter: { type: 'number' },
                                minFare: { type: 'number' },
                                surgeMultiplier: { type: 'number' },
                                isActive: { type: 'boolean' }
                            }
                        }
                    }
                }
            },
            responses: { 200: { description: 'Updated successfully' } }
        },
        delete: {
            summary: 'Delete a vehicle type (Admin only)',
            tags: ['Vehicle Types'],
            security: [{ BearerAuth: [] }],
            parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
            responses: { 200: { description: 'Deleted successfully' } }
        }
    },
    '/api/vehicle-types/calculate-price': {
        post: {
            summary: 'Calculate prices for all active vehicle types',
            tags: ['Vehicle Types'],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['distance_meters'],
                            properties: { distance_meters: { type: 'number' } }
                        }
                    }
                }
            },
            responses: { 200: { description: 'Calculated prices' } }
        }
    },
`;

if (!swaggerContent.includes("'/api/vehicle-types': {")) {
    // Insert before "module.exports = options.definition;"
    swaggerContent = swaggerContent.replace(
        "options.definition.paths = _swaggerPaths;",
        "Object.assign(_swaggerPaths, {" + pathsToAdd + "});\noptions.definition.paths = _swaggerPaths;"
    );
}

fs.writeFileSync(swaggerPath, swaggerContent, 'utf8');
console.log('Swagger updated successfully!');

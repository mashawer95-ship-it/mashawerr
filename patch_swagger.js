const fs = require('fs');
const path = require('path');

const swaggerPath = path.join(__dirname, 'config', 'swagger.js');
let swaggerContent = fs.readFileSync(swaggerPath, 'utf8');

// Patch 1: Add lat, lng to /api/users/{id}/availability requestBody
const oldAvailabilityProps = `
                                    properties: {
                                        isAvailable: {
                                            type: 'boolean',
                                            example: true,
                                            description: '\`true\` = online (accepting orders) | \`false\` = offline',
                                        },
                                    },
`;
const newAvailabilityProps = `
                                    properties: {
                                        isAvailable: {
                                            type: 'boolean',
                                            example: true,
                                            description: '\`true\` = online (accepting orders) | \`false\` = offline',
                                        },
                                        lat: {
                                            type: 'number',
                                            example: 29.3762,
                                            description: 'Latitude of the representative',
                                        },
                                        lng: {
                                            type: 'number',
                                            example: 47.9780,
                                            description: 'Longitude of the representative',
                                        },
                                    },
`;

if (swaggerContent.includes("isAvailable: {") && !swaggerContent.includes("Latitude of the representative")) {
    swaggerContent = swaggerContent.replace(
        "properties: {\n                                        isAvailable: {\n                                            type: 'boolean',\n                                            example: true,\n                                            description: '`true` = online (accepting orders) | `false` = offline',\n                                        },\n                                    },",
        newAvailabilityProps.trim()
    );
}


// Patch 2: Add lat, lng to /api/orders/waiting query params
const oldWaitingParams = `
                    operationId: 'listWaitingOrders',
                    responses: {
`;
const newWaitingParams = `
                    operationId: 'listWaitingOrders',
                    parameters: [
                        { name: 'lat', in: 'query', schema: { type: 'number' }, description: 'Representative latitude' },
                        { name: 'lng', in: 'query', schema: { type: 'number' }, description: 'Representative longitude' }
                    ],
                    responses: {
`;
if (swaggerContent.includes("operationId: 'listWaitingOrders',") && !swaggerContent.includes("name: 'lat', in: 'query'")) {
    swaggerContent = swaggerContent.replace(
        "operationId: 'listWaitingOrders',\n                    responses: {",
        newWaitingParams.trim()
    );
}

fs.writeFileSync(swaggerPath, swaggerContent, 'utf8');
console.log('Swagger patched!');

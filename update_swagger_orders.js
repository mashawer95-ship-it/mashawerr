const fs = require('fs');
const path = require('path');

const swaggerPath = path.join(__dirname, 'config', 'swagger.js');
let swaggerContent = fs.readFileSync(swaggerPath, 'utf8');

const availabilityPath = `
_swaggerPaths['/api/users/{id}/availability'] = {
    patch: {
        summary: 'Toggle Representative Availability',
        description: 'Toggle isAvailable status and optionally update lat/lng location for a representative.',
        tags: ['Users'],
        security: [{ BearerAuth: [] }],
        parameters: [
            {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description: 'User ID'
            }
        ],
        requestBody: {
            required: true,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: {
                            isAvailable: { type: 'boolean' },
                            lat: { type: 'number' },
                            lng: { type: 'number' }
                        },
                        required: ['isAvailable']
                    }
                }
            }
        },
        responses: {
            200: { description: 'Availability updated successfully' },
            400: { description: 'Bad Request' },
            404: { description: 'User not found' }
        }
    }
};
`;

const waitingOrdersPath = `
_swaggerPaths['/api/orders/waiting'] = {
    get: {
        summary: 'Get Waiting Orders for Representative',
        description: 'Returns all waiting orders. If lat and lng are provided, returns progressively filtered orders within 5km, 7km, 10km, or max 15km.',
        tags: ['Orders'],
        security: [{ BearerAuth: [] }],
        parameters: [
            {
                name: 'lat',
                in: 'query',
                required: false,
                schema: { type: 'number' },
                description: 'Representative latitude'
            },
            {
                name: 'lng',
                in: 'query',
                required: false,
                schema: { type: 'number' },
                description: 'Representative longitude'
            }
        ],
        responses: {
            200: { description: 'Waiting orders retrieved successfully' }
        }
    }
};
`;

let modified = false;

if (!swaggerContent.includes("'/api/users/{id}/availability'")) {
    swaggerContent = swaggerContent.replace(
        "options.definition.paths = _swaggerPaths;",
        availabilityPath + "\noptions.definition.paths = _swaggerPaths;"
    );
    modified = true;
}

if (!swaggerContent.includes("'/api/orders/waiting'")) {
    swaggerContent = swaggerContent.replace(
        "options.definition.paths = _swaggerPaths;",
        waitingOrdersPath + "\noptions.definition.paths = _swaggerPaths;"
    );
    modified = true;
}

if (modified) {
    fs.writeFileSync(swaggerPath, swaggerContent, 'utf8');
    console.log('Swagger updated successfully!');
} else {
    console.log('Swagger endpoints already exist.');
}

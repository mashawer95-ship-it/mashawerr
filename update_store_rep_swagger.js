const fs = require('fs');
const path = require('path');

const swaggerPath = path.join(__dirname, 'config', 'swagger.js');
let swaggerContent = fs.readFileSync(swaggerPath, 'utf8');

const newPaths = `
_swaggerPaths['/api/store/orders/representative/pending'] = {
    get: {
        summary: 'Get Pending Store Orders for Representative',
        tags: ['StoreOrders - Representative'],
        security: [{ BearerAuth: [] }],
        parameters: [
            { name: 'lat', in: 'query', required: false, schema: { type: 'number' } },
            { name: 'lng', in: 'query', required: false, schema: { type: 'number' } },
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } }
        ],
        responses: {
            200: { description: 'Success' }
        }
    }
};

_swaggerPaths['/api/store/orders/representative/my'] = {
    get: {
        summary: 'Get Accepted Store Orders for Representative',
        tags: ['StoreOrders - Representative'],
        security: [{ BearerAuth: [] }],
        parameters: [
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } }
        ],
        responses: {
            200: { description: 'Success' }
        }
    }
};

_swaggerPaths['/api/store/orders/{id}/accept'] = {
    patch: {
        summary: 'Accept a Store Order by Representative',
        tags: ['StoreOrders - Representative'],
        security: [{ BearerAuth: [] }],
        parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
            200: { description: 'Accepted successfully' }
        }
    }
};

_swaggerPaths['/api/store/orders/{id}/representative-status'] = {
    patch: {
        summary: 'Update Store Order Status by Representative',
        tags: ['StoreOrders - Representative'],
        security: [{ BearerAuth: [] }],
        parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
            required: true,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        properties: { status: { type: 'string' } },
                        required: ['status']
                    }
                }
            }
        },
        responses: {
            200: { description: 'Status updated successfully' }
        }
    }
};

_swaggerPaths['/api/store/orders/{id}/photo/{stage}'] = {
    post: {
        summary: 'Upload Store Order Photo (pickup or delivery)',
        tags: ['StoreOrders - Representative'],
        security: [{ BearerAuth: [] }],
        parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'stage', in: 'path', required: true, schema: { type: 'string', enum: ['pickup', 'delivery'] } }
        ],
        requestBody: {
            required: true,
            content: {
                'multipart/form-data': {
                    schema: {
                        type: 'object',
                        properties: { photo: { type: 'string', format: 'binary' } }
                    }
                }
            }
        },
        responses: {
            200: { description: 'Photo uploaded successfully' }
        }
    }
};
`;

if (!swaggerContent.includes("'/api/store/orders/representative/pending'")) {
    swaggerContent = swaggerContent.replace(
        "options.definition.paths = _swaggerPaths;",
        newPaths + "\noptions.definition.paths = _swaggerPaths;"
    );
    fs.writeFileSync(swaggerPath, swaggerContent, 'utf8');
    console.log('Swagger updated successfully with Store Representative endpoints!');
} else {
    console.log('Store Representative endpoints already exist in Swagger.');
}

const fs = require('fs');
const path = require('path');

const swaggerPath = path.join(__dirname, 'config', 'swagger.js');
let swaggerContent = fs.readFileSync(swaggerPath, 'utf8');

// Add Paths
const pathsToAdd = `
    '/api/discounts/global-active': {
        get: {
            summary: 'Get the active global discount (Public)',
            tags: ['Discounts'],
            responses: { 200: { description: 'Active global discount details' } }
        }
    },
    '/api/discounts/global': {
        get: {
            summary: 'Get global discount configuration (Admin)',
            tags: ['Discounts'],
            security: [{ BearerAuth: [] }],
            responses: { 200: { description: 'Global discount config' } }
        },
        put: {
            summary: 'Update global discount configuration (Admin)',
            tags: ['Discounts'],
            security: [{ BearerAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: {
                                discountPercentage: { type: 'number' },
                                isActive: { type: 'boolean' },
                                expiresAt: { type: 'string', format: 'date-time' }
                            }
                        }
                    }
                }
            },
            responses: { 200: { description: 'Global discount updated' } }
        }
    },
`;

if (!swaggerContent.includes("'/api/discounts/global-active': {")) {
    swaggerContent = swaggerContent.replace(
        "options.definition.paths = _swaggerPaths;",
        "Object.assign(_swaggerPaths, {" + pathsToAdd + "});\noptions.definition.paths = _swaggerPaths;"
    );
    fs.writeFileSync(swaggerPath, swaggerContent, 'utf8');
    console.log('Swagger updated successfully!');
} else {
    console.log('Swagger already contains global discount paths.');
}

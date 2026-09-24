const express = require('express');
const router = express.Router();

const { getAllAgents, getAgentProducts, getAgentsOverview } = require('../Controllers/agentController');
const { adminOnly } = require('../middlewares/authorize');

// ─── Admin only ───────────────────────────────────────────────────────────────

/**
 * GET /api/store/agents
 * List all agents (id, name, email, phone)
 */
router.get('/', adminOnly, getAllAgents);

/**
 * GET /api/store/agents/overview
 * All agents with product count each
 */
router.get('/overview', adminOnly, getAgentsOverview);

/**
 * GET /api/store/agents/:agentId/products
 * All products for a specific agent
 * Query: page, limit, search, category, isSoldOut, isActive
 */
router.get('/:agentId/products', adminOnly, getAgentProducts);

module.exports = router;

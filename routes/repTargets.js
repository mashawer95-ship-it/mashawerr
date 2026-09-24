const express = require('express');
const router = express.Router();
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const {
    upsertRepTarget,
    getRepTargets,
    deleteRepTarget,
    upsertGlobalTarget,
    getGlobalTargets,
    deleteGlobalTarget,
    getGlobalProgress,
    getMyTargets,
    approveTargetReward,
} = require('../Controllers/repTargetController');

// ── Global targets (Admin) ────────────────────────────────────────────────────

// GET  /api/rep-targets/global          → all global targets + overall progress
// POST /api/rep-targets/global          → create/update global target
// DELETE /api/rep-targets/global/:period → deactivate global target for period
router.get('/global', verifyTokenAndAdmin, getGlobalTargets);
router.post('/global', verifyTokenAndAdmin, upsertGlobalTarget);
router.delete('/global/:period', verifyTokenAndAdmin, deleteGlobalTarget);

// GET /api/rep-targets/global/progress?period=monthly
// Full summary: all reps + progress + wallets
router.get('/global/progress', verifyTokenAndAdmin, getGlobalProgress);

// POST /api/rep-targets/approve-reward  → Admin approves achievement & credits wallet
router.post('/approve-reward', verifyTokenAndAdmin, approveTargetReward);

// ── Rep-facing: own targets + wallet ─────────────────────────────────────────
// GET /api/rep-targets/my/:repId
router.get('/my/:repId', verifyToken, getMyTargets);

// ── Individual rep targets (Admin) ───────────────────────────────────────────

// POST /api/rep-targets/rep/:repId         → create/update target for a rep
// GET  /api/rep-targets/rep/:repId         → get targets + progress + wallet
// DELETE /api/rep-targets/rep/:repId/:period → deactivate a period target
router.post('/rep/:repId',           verifyTokenAndAdmin, upsertRepTarget);
router.get('/rep/:repId',            verifyToken, getRepTargets);
router.delete('/rep/:repId/:period', verifyTokenAndAdmin, deleteRepTarget);

module.exports = router;


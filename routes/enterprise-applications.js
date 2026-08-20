const express = require('express');

const database = require('../db');
const { asyncHandler } = require('../middleware/async-handler');
const { submitEnterpriseApplication } = require('../services/enterprise-applications');

const router = express.Router();

router.post('/enterprise-applications', asyncHandler(async (req, res) => {
  const application = await submitEnterpriseApplication(database.getDB(), req.body);
  await database.saveDB();
  res.status(201).json({
    success: true,
    data: { id: application.id, status: application.status },
  });
}));

module.exports = router;

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { listTicketSources, tableExists } = require('../services/ticket-source-audit');

const router = express.Router();

router.get('/ticket-source-audits', requireAuth, requireAdmin, (req, res) => {
  if (!tableExists()) return res.json({ data: [] });
  const data = listTicketSources({
    tenantId: req.user.tenant_id,
    ticketId: String(req.query.ticket_id || req.query.ticketId || '').trim(),
    communityId: String(req.query.community_id || req.query.communityId || '').trim(),
    from: String(req.query.from || '').trim(),
    to: String(req.query.to || '').trim(),
  });
  res.json({ data: data.map((row) => ({
    id: row.id,
    ticket_id: row.ticket_id,
    enterprise_name: row.enterprise_name,
    community_id: row.community_id,
    community_name: row.community_name,
    feedback_person: row.feedback_person,
    feedback_group: row.feedback_group,
    original_message: row.original_message,
    source: row.source,
    created_at: row.created_at,
  })) });
});

module.exports = router;

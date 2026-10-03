// Keep the audit protection rule identical in the live writer and the offline
// archive shadow. Pending effects and live terminals are recovery evidence.
export const MAX_PENDING_RETENTION_CLEANUPS = 16;
export function trimAudit(db) {
  db.prepare(`DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 9999)
    AND target NOT IN (SELECT id FROM runs WHERE status IN ('queued', 'launching', 'running')
      OR (status = 'interrupted' AND recovery_decision IS NULL))
    AND NOT ((action LIKE '%.requested'
      AND (CASE WHEN json_valid(details) THEN json_extract(details, '$.operationId') END) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM audit_log AS outcome WHERE outcome.id > audit_log.id
        AND (CASE WHEN json_valid(outcome.details) THEN json_extract(outcome.details, '$.operationId') END)
          = json_extract(audit_log.details, '$.operationId')))
      OR (action IN ('terminal.created', 'terminal.create.unknown', 'terminal.unknown')
        AND NOT EXISTS (SELECT 1 FROM audit_log AS outcome WHERE outcome.id > audit_log.id
          AND outcome.target = audit_log.target AND outcome.action IN ('terminal.exited', 'terminal.closed', 'terminal.recovered', 'terminal.create.failed'))))`).run();
}

export const pendingCleanupSql = `SELECT request.id, json_extract(request.details, '$.operationId') AS operationId
  FROM audit_log AS request WHERE request.action = 'retention.cleanup.requested'
  AND json_valid(request.details)
  AND json_extract(request.details, '$.operationId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM audit_log AS outcome WHERE outcome.id > request.id
    AND json_valid(outcome.details)
    AND json_extract(outcome.details, '$.operationId') = json_extract(request.details, '$.operationId'))`;

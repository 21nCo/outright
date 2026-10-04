// Keep the audit protection rule identical in the live writer and the offline
// archive shadow. Pending effects and live terminals are recovery evidence.
export const MAX_PENDING_RETENTION_CLEANUPS = 16;
export const AUDIT_RETENTION_LIMIT = 10_000;
export function trimAudit(db, limit = -1, afterId = 0, throughId = Number.MAX_SAFE_INTEGER) {
  return db.prepare(`DELETE FROM audit_log WHERE id IN (SELECT audit_log.id FROM audit_log
    WHERE id > ? AND id <= ?
    AND id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ${AUDIT_RETENTION_LIMIT - 1})
    AND target NOT IN (SELECT id FROM runs WHERE status IN ('queued', 'launching', 'running')
      OR (status = 'interrupted' AND recovery_decision IS NULL))
    AND NOT ((action LIKE '%.requested'
      AND (CASE WHEN json_valid(details) THEN json_extract(details, '$.operationId') END) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM audit_log AS outcome WHERE outcome.id > audit_log.id
        AND (CASE WHEN json_valid(outcome.details) THEN json_extract(outcome.details, '$.operationId') END)
          = json_extract(audit_log.details, '$.operationId')))
      OR (action IN ('terminal.create.requested', 'terminal.created', 'terminal.create.unknown', 'terminal.unknown')
        AND NOT EXISTS (SELECT 1 FROM audit_log AS outcome WHERE outcome.id > audit_log.id
          AND outcome.target = audit_log.target AND outcome.action IN ('terminal.exited', 'terminal.closed', 'terminal.recovered', 'terminal.create.failed'))))
    ORDER BY audit_log.id LIMIT ?)`).run(afterId, throughId, limit).changes;
}

// A protected old row must not make every later write rescan the same prefix.
// Persist the cursor in the same SQLite transaction as the deletion so an
// interrupted cleanup can resume without losing its recovery evidence.
export function trimAuditPage(db, pageSize = 32, upperId = Number.MAX_SAFE_INTEGER) {
  return db.transaction(() => {
    const cursor = db.prepare("SELECT cursor FROM audit_retention_cursor WHERE id = 1").get().cursor;
    const rows = db.prepare(`SELECT id FROM audit_log WHERE id > ? AND id <= ?
      AND id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ${AUDIT_RETENTION_LIMIT - 1})
      ORDER BY id LIMIT ?`).all(cursor, upperId, pageSize);
    if (!rows.length) {
      db.prepare("UPDATE audit_retention_cursor SET cursor = 0 WHERE id = 1").run();
      return { scanned: 0, deleted: 0, complete: true };
    }
    const lastId = rows.at(-1).id;
    const deleted = trimAudit(db, pageSize, cursor, lastId);
    db.prepare("UPDATE audit_retention_cursor SET cursor = ? WHERE id = 1").run(lastId);
    return { scanned: rows.length, deleted, complete: false };
  }).immediate();
}

export const pendingCleanupSql = `SELECT request.id, json_extract(request.details, '$.operationId') AS operationId
  FROM audit_log AS request WHERE request.action = 'retention.cleanup.requested'
  AND json_valid(request.details)
  AND json_extract(request.details, '$.operationId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM audit_log AS outcome WHERE outcome.id > request.id
    AND json_valid(outcome.details)
    AND json_extract(outcome.details, '$.operationId') = json_extract(request.details, '$.operationId'))`;

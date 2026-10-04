// Keep the audit protection rule identical in the live writer and the offline
// archive shadow. Pending effects and live terminals are recovery evidence.
export const MAX_PENDING_RETENTION_CLEANUPS = 16;
export const AUDIT_RETENTION_LIMIT = 10_000;
// A small indexed projection contains only rows that can participate in a
// recovery dependency. Triggers cover direct SQLite writers and the bounded
// startup audit scan backfills legacy rows before any trimming is allowed.
export function prepareAuditEvidence(db, hadAudit) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_evidence (
      id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT, operation_id TEXT);
    CREATE INDEX IF NOT EXISTS audit_evidence_target ON audit_evidence(target, id);
    CREATE INDEX IF NOT EXISTS audit_evidence_operation ON audit_evidence(operation_id, id);
    CREATE INDEX IF NOT EXISTS audit_evidence_action ON audit_evidence(action, id);
    CREATE TABLE IF NOT EXISTS audit_evidence_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), complete INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS audit_evidence_insert AFTER INSERT ON audit_log
    WHEN NEW.action IN ('terminal.create.requested', 'terminal.created', 'terminal.create.unknown',
      'terminal.unknown', 'terminal.exited', 'terminal.closed', 'terminal.recovered', 'terminal.create.failed')
      OR NEW.action LIKE '%.requested'
      OR (json_valid(NEW.details) AND json_extract(NEW.details, '$.operationId') IS NOT NULL)
    BEGIN
      INSERT INTO audit_evidence (id, action, target, operation_id)
        VALUES (NEW.id, NEW.action, NEW.target,
          CASE WHEN json_valid(NEW.details) THEN json_extract(NEW.details, '$.operationId') END);
    END;
    CREATE TRIGGER IF NOT EXISTS audit_evidence_delete AFTER DELETE ON audit_log
    BEGIN DELETE FROM audit_evidence WHERE id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS audit_evidence_update AFTER UPDATE OF id, action, target, details ON audit_log
    BEGIN
      DELETE FROM audit_evidence WHERE id = OLD.id;
      INSERT INTO audit_evidence (id, action, target, operation_id)
        SELECT NEW.id, NEW.action, NEW.target,
          CASE WHEN json_valid(NEW.details) THEN json_extract(NEW.details, '$.operationId') END
        WHERE NEW.action IN ('terminal.create.requested', 'terminal.created', 'terminal.create.unknown',
          'terminal.unknown', 'terminal.exited', 'terminal.closed', 'terminal.recovered', 'terminal.create.failed')
          OR NEW.action LIKE '%.requested'
          OR (json_valid(NEW.details) AND json_extract(NEW.details, '$.operationId') IS NOT NULL);
    END;`);
  db.prepare("INSERT OR IGNORE INTO audit_evidence_state (id, complete) VALUES (1, ?)").run(hadAudit ? 0 : 1);
}

export function backfillAuditEvidencePage(db, afterId, throughId) {
  db.prepare(`INSERT OR IGNORE INTO audit_evidence (id, action, target, operation_id)
    SELECT id, action, target, CASE WHEN json_valid(details) THEN json_extract(details, '$.operationId') END
    FROM audit_log WHERE id > ? AND id <= ? AND (
      action IN ('terminal.create.requested', 'terminal.created', 'terminal.create.unknown',
        'terminal.unknown', 'terminal.exited', 'terminal.closed', 'terminal.recovered', 'terminal.create.failed')
      OR action LIKE '%.requested'
      OR (json_valid(details) AND json_extract(details, '$.operationId') IS NOT NULL))`).run(afterId, throughId);
}
// Expose the executed statement so its bounded candidate plan can be checked
// without a wall-clock assertion that varies with host load.
export const auditTrimSql = `WITH candidates AS MATERIALIZED (
      SELECT id, action, target,
        CASE WHEN json_valid(details) THEN json_extract(details, '$.operationId') END AS operation_id
      FROM audit_log WHERE id > ? AND id <= ?
        AND id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ${AUDIT_RETENTION_LIMIT - 1})
      ORDER BY id LIMIT ?)
    DELETE FROM audit_log WHERE id IN (
      SELECT candidate.id FROM candidates AS candidate
      WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = candidate.target
        AND (status IN ('queued', 'launching', 'running')
          OR (status = 'interrupted' AND recovery_decision IS NULL)))
      AND NOT (
        (candidate.action LIKE '%.requested' AND candidate.operation_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM audit_evidence AS outcome
            WHERE outcome.operation_id = candidate.operation_id AND outcome.id > candidate.id))
        OR (candidate.action IN ('terminal.create.requested', 'terminal.created',
            'terminal.create.unknown', 'terminal.unknown')
          AND NOT EXISTS (SELECT 1 FROM audit_evidence AS outcome
            WHERE outcome.target = candidate.target AND outcome.id > candidate.id
              AND outcome.action IN ('terminal.exited', 'terminal.closed',
                'terminal.recovered', 'terminal.create.failed')))
        OR (candidate.action IN ('terminal.exited', 'terminal.closed',
            'terminal.recovered', 'terminal.create.failed')
          AND EXISTS (SELECT 1 FROM audit_evidence AS owner
            WHERE owner.target = candidate.target AND owner.id < candidate.id
              AND owner.action IN ('terminal.create.requested', 'terminal.created',
                'terminal.create.unknown', 'terminal.unknown')))
        OR (candidate.operation_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM audit_evidence AS request
            WHERE request.operation_id = candidate.operation_id AND request.id < candidate.id
              AND request.action LIKE '%.requested'))))`;

export function trimAudit(db, limit = -1, afterId = 0, throughId = Number.MAX_SAFE_INTEGER) {
  if (!db.prepare("SELECT complete FROM audit_evidence_state WHERE id = 1").get()?.complete) return 0;
  // Materialize a raw-id page before testing dependencies. The old query
  // examined an unbounded eligible prefix for each supposedly bounded page.
  return db.prepare(auditTrimSql).run(afterId, throughId, limit).changes;
}

// A protected old row must not make every later write rescan the same prefix.
// Persist the cursor in the same SQLite transaction as the deletion so an
// interrupted cleanup can resume without losing its recovery evidence.
export function trimAuditPage(db, pageSize = 32, upperId = Number.MAX_SAFE_INTEGER) {
  if (!db.prepare("SELECT complete FROM audit_evidence_state WHERE id = 1").get()?.complete) {
    return { scanned: 0, deleted: 0, complete: false };
  }
  return db.transaction(() => {
    const state = db.prepare("SELECT cursor, sweep_upper FROM audit_retention_cursor WHERE id = 1").get();
    const cursor = state.cursor;
    // Freeze the high-water mark for this pass. Continuous writes cannot keep
    // extending the pass and strand an old protected owner behind the cursor.
    const sweepUpper = state.sweep_upper || (db.prepare(`SELECT id FROM audit_log ORDER BY id DESC
      LIMIT 1 OFFSET ${AUDIT_RETENTION_LIMIT - 1}`).get()?.id ?? 0);
    const rows = db.prepare(`SELECT id FROM audit_log WHERE id > ? AND id <= ?
      ORDER BY id LIMIT ?`).all(cursor, Math.min(upperId, sweepUpper), pageSize);
    if (!rows.length) {
      db.prepare("UPDATE audit_retention_cursor SET cursor = 0, sweep_upper = 0 WHERE id = 1").run();
      return { scanned: 0, deleted: 0, complete: true };
    }
    const lastId = rows.at(-1).id;
    let deleted = trimAudit(db, pageSize, cursor, lastId);
    if (deleted) deleted += trimAudit(db, pageSize, cursor, lastId);
    db.prepare("UPDATE audit_retention_cursor SET cursor = ?, sweep_upper = ? WHERE id = 1").run(lastId, sweepUpper);
    return { scanned: rows.length, deleted, complete: false };
  }).immediate();
}

// Both sides use the trigger-maintained projection. An action lookup visits
// only cleanup requests, and the operation lookup cannot traverse telemetry.
// Callers must wait for the legacy projection backfill before using this query.
export const pendingCleanupSql = `SELECT request.id, request.operation_id AS operationId
  FROM audit_evidence AS request WHERE request.action = 'retention.cleanup.requested'
  AND request.operation_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM audit_evidence AS outcome
    WHERE outcome.operation_id = request.operation_id AND outcome.id > request.id)`;

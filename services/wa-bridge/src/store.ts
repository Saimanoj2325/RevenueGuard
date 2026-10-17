import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export interface StoredMessage {
  id: string
  chat_id: string
  from: string
  from_name: string | null
  ts: number // unix seconds
  text: string | null
  direction: 'in' | 'out'
  media_mime: string | null
  media_filename: string | null
  media_path: string | null
  media_size: number | null
  /** sent to the API (or deliberately not: history sync / no longer allowlisted) */
  forwarded: boolean
  /** WhatsApp "Forwarded" label (contextInfo.isForwarded) */
  is_forwarded: boolean
  quoted_id: string | null
  /** base64 SHA-256 of the media file */
  media_sha256: string | null
  /** sender deleted it for everyone (kept locally, hidden from search) */
  deleted: boolean
  /** unix seconds of the last edit, null if never edited */
  edited_at: number | null
}

export type LifecycleKind = 'edit' | 'delete'
export interface LifecycleEvent {
  seq: number
  kind: LifecycleKind
  msg_id: string
  chat_id: string
  from: string
  ts: number
  text: string | null
  forwarded: boolean
}

type NewMessage = Omit<StoredMessage, 'forwarded' | 'is_forwarded' | 'quoted_id' | 'media_sha256' | 'deleted' | 'edited_at'> & {
  forwarded?: boolean
  is_forwarded?: boolean
  quoted_id?: string | null
  media_sha256?: string | null
}

export type IdempotencyStatus = 'pending' | 'sent' | 'failed'
export interface IdempotencyRow {
  key: string
  approval_id: string
  to_jid: string
  payload_hash: string
  status: IdempotencyStatus
  message_id: string | null
  error: string | null
  created_at: number
}

/** Local sqlite store: allowed inbound/outbound messages (for whatsapp_search), /send idempotency cache,
 *  chat allowlist, chat-picker metadata (names/timestamps only) and pending WhatsApp approval prompts. */
export class Store {
  readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        from_jid TEXT NOT NULL,
        from_name TEXT,
        ts INTEGER NOT NULL,
        text TEXT,
        direction TEXT NOT NULL DEFAULT 'in',
        media_mime TEXT,
        media_filename TEXT,
        media_path TEXT,
        media_size INTEGER,
        forwarded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_messages_forwarded ON messages(forwarded) WHERE forwarded = 0;
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        to_jid TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        message_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      -- privacy allowlist: only these chats are stored / forwarded (empty = drop everything)
      CREATE TABLE IF NOT EXISTS allowlist (
        jid TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- chat picker metadata only (never message bodies)
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      -- approval prompts sent via /send-internal: approver phone -> pending approval token
      CREATE TABLE IF NOT EXISTS pending_approvals (
        phone TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      -- message edits / deletes for everyone (CONTRACT_V3 §2); dedupe_key collapses the
      -- messages.upsert protocolMessage and the messages.update Baileys emits for the same change
      CREATE TABLE IF NOT EXISTS message_lifecycle (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        from_jid TEXT NOT NULL,
        ts INTEGER NOT NULL,
        text TEXT,
        forwarded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_lifecycle_forwarded ON message_lifecycle(forwarded) WHERE forwarded = 0;
    `)
    // additive migrations for databases created before v3
    const cols = new Set((this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name))
    const add: [string, string][] = [
      ['is_forwarded', 'INTEGER NOT NULL DEFAULT 0'],
      ['quoted_id', 'TEXT'],
      ['media_sha256', 'TEXT'],
      ['deleted', 'INTEGER NOT NULL DEFAULT 0'],
      ['edited_at', 'INTEGER'],
    ]
    for (const [name, def] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${def}`)
  }

  // ---------- allowlist ----------

  allowlistInitialized(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM meta WHERE key = 'allowlist_initialized'`).get()
  }

  getAllowlist(): string[] {
    return (this.db.prepare('SELECT jid FROM allowlist ORDER BY jid').all() as { jid: string }[]).map((r) => r.jid)
  }

  /** Replace the whole allowlist (jids must already be normalised). */
  setAllowlist(jids: string[]): string[] {
    const tx = this.db.transaction((list: string[]) => {
      this.db.prepare('DELETE FROM allowlist').run()
      const ins = this.db.prepare('INSERT OR IGNORE INTO allowlist (jid) VALUES (?)')
      for (const j of list) ins.run(j)
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('allowlist_initialized', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run()
    })
    tx(jids)
    return this.getAllowlist()
  }

  // ---------- chat picker metadata ----------

  upsertChat(c: { jid: string; name?: string | null; is_group?: boolean; last_message_at?: number | null }): void {
    this.db
      .prepare(`INSERT INTO chats (jid, name, is_group, last_message_at) VALUES (@jid, @name, @is_group, @last)
                ON CONFLICT(jid) DO UPDATE SET
                  name = COALESCE(excluded.name, chats.name),
                  is_group = MAX(chats.is_group, excluded.is_group),
                  last_message_at = MAX(COALESCE(chats.last_message_at, 0), COALESCE(excluded.last_message_at, 0))`)
      .run({ jid: c.jid, name: c.name || null, is_group: c.is_group ? 1 : 0, last: c.last_message_at ?? null })
  }

  upsertContact(jid: string, name: string): void {
    this.db.prepare('INSERT INTO contacts (jid, name) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name').run(jid, name)
  }

  listChats(limit = 500): { jid: string; name: string | null; is_group: boolean; last_message_at: number | null }[] {
    const rows = this.db
      .prepare(`SELECT c.jid, COALESCE(c.name, k.name) AS name, c.is_group, c.last_message_at
                FROM chats c LEFT JOIN contacts k ON k.jid = c.jid
                ORDER BY COALESCE(c.last_message_at, 0) DESC, c.jid LIMIT ?`)
      .all(Math.min(Math.max(limit, 1), 2000)) as { jid: string; name: string | null; is_group: number; last_message_at: number | null }[]
    return rows.map((r) => ({ jid: r.jid, name: r.name ?? null, is_group: Number(r.is_group) === 1, last_message_at: r.last_message_at ? Number(r.last_message_at) : null }))
  }

  // ---------- pending approval prompts ----------

  setPendingApproval(p: { phone: string; approval_id: string; token: string; expires_at: number }): void {
    this.db
      .prepare(`INSERT INTO pending_approvals (phone, approval_id, token, expires_at) VALUES (@phone, @approval_id, @token, @expires_at)
                ON CONFLICT(phone) DO UPDATE SET approval_id = excluded.approval_id, token = excluded.token, expires_at = excluded.expires_at, created_at = unixepoch()`)
      .run(p)
  }

  getPendingApproval(phone: string): { phone: string; approval_id: string; token: string; expires_at: number } | null {
    const r = this.db.prepare('SELECT phone, approval_id, token, expires_at FROM pending_approvals WHERE phone = ?').get(phone) as
      | { phone: string; approval_id: string; token: string; expires_at: number }
      | undefined
    return r ? { ...r, expires_at: Number(r.expires_at) } : null
  }

  deletePendingApproval(phone: string, approvalId?: string): void {
    if (approvalId) this.db.prepare('DELETE FROM pending_approvals WHERE phone = ? AND approval_id = ?').run(phone, approvalId)
    else this.db.prepare('DELETE FROM pending_approvals WHERE phone = ?').run(phone)
  }

  purgeExpiredApprovals(nowSec = Math.floor(Date.now() / 1000)): number {
    return this.db.prepare('DELETE FROM pending_approvals WHERE expires_at <= ?').run(nowSec).changes
  }

  upsertMessage(m: NewMessage): boolean {
    const r = this.db
      .prepare(`INSERT INTO messages (id, chat_id, from_jid, from_name, ts, text, direction, media_mime, media_filename, media_path, media_size, forwarded, is_forwarded, quoted_id, media_sha256)
                VALUES (@id, @chat_id, @from, @from_name, @ts, @text, @direction, @media_mime, @media_filename, @media_path, @media_size, @forwarded, @is_forwarded, @quoted_id, @media_sha256)
                ON CONFLICT(id) DO NOTHING`)
      .run({ ...m, forwarded: m.forwarded ? 1 : 0, is_forwarded: m.is_forwarded ? 1 : 0, quoted_id: m.quoted_id ?? null, media_sha256: m.media_sha256 ?? null })
    if (r.changes === 0) return false
    // an edit/delete that arrived before the original: apply it to the local copy now
    const edit = this.db.prepare(`SELECT text, ts FROM message_lifecycle WHERE msg_id = ? AND kind = 'edit' ORDER BY ts DESC, seq DESC LIMIT 1`).get(m.id) as { text: string | null; ts: number } | undefined
    if (edit) this.db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(edit.text, edit.ts, m.id)
    if (this.db.prepare(`SELECT 1 FROM message_lifecycle WHERE msg_id = ? AND kind = 'delete'`).get(m.id)) this.db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(m.id)
    return true
  }

  // ---------- edits / deletes ----------

  /** Record an edit/delete once. Returns the event, or null when this exact change was already recorded. */
  recordLifecycle(e: { kind: LifecycleKind; msg_id: string; chat_id: string; from: string; ts: number; text?: string | null; forwarded?: boolean }): LifecycleEvent | null {
    const dedupe = e.kind === 'delete' ? `delete:${e.msg_id}` : `edit:${e.msg_id}:${e.text ?? ''}`
    const r = this.db
      .prepare(`INSERT INTO message_lifecycle (dedupe_key, kind, msg_id, chat_id, from_jid, ts, text, forwarded)
                VALUES (@dedupe, @kind, @msg_id, @chat_id, @from, @ts, @text, @forwarded) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run({ dedupe, kind: e.kind, msg_id: e.msg_id, chat_id: e.chat_id, from: e.from, ts: e.ts, text: e.text ?? null, forwarded: e.forwarded ? 1 : 0 })
    if (r.changes === 0) return null
    // keep the local search copy current (no-op when the original was never stored here)
    if (e.kind === 'edit') this.db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(e.text ?? null, e.ts, e.msg_id)
    else this.db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(e.msg_id)
    return this.getLifecycle(Number(r.lastInsertRowid))
  }

  getLifecycle(seq: number): LifecycleEvent | null {
    const r = this.db.prepare('SELECT * FROM message_lifecycle WHERE seq = ?').get(seq)
    return r ? rowToLifecycle(r) : null
  }

  markLifecycleForwarded(seq: number): void {
    this.db.prepare('UPDATE message_lifecycle SET forwarded = 1 WHERE seq = ?').run(seq)
  }

  unforwardedLifecycle(limit = 50): LifecycleEvent[] {
    return this.db.prepare('SELECT * FROM message_lifecycle WHERE forwarded = 0 ORDER BY seq ASC LIMIT ?').all(limit).map(rowToLifecycle)
  }

  lifecycleCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM message_lifecycle').get() as { n: number }).n
  }

  get(id: string): StoredMessage | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    return r ? rowToMessage(r) : null
  }

  markForwarded(id: string): void {
    this.db.prepare('UPDATE messages SET forwarded = 1 WHERE id = ?').run(id)
  }

  unforwarded(limit = 50): StoredMessage[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE forwarded = 0 AND direction = 'in' ORDER BY ts ASC LIMIT ?`)
      .all(limit)
      .map(rowToMessage)
  }

  search(opts: { q?: string; chat?: string; since?: number; limit?: number; chats?: string[] }): StoredMessage[] {
    const where: string[] = ['deleted = 0']
    const params: Record<string, unknown> = {}
    if (opts.q) {
      // every whitespace-separated term must appear (case-insensitive) in text or sender name
      opts.q.split(/\s+/).filter(Boolean).slice(0, 8).forEach((term, i) => {
        where.push(`(text LIKE @q${i} ESCAPE '\\' OR from_name LIKE @q${i} ESCAPE '\\' OR media_filename LIKE @q${i} ESCAPE '\\')`)
        params[`q${i}`] = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      })
    }
    if (opts.chat) {
      where.push('chat_id = @chat')
      params.chat = opts.chat
    }
    if (opts.chats) {
      // inbound rows only from these chats; our own outbound (gateway-approved) messages stay searchable
      where.push(opts.chats.length ? `(direction = 'out' OR chat_id IN (${opts.chats.map((_, i) => `@c${i}`).join(', ')}))` : `direction = 'out'`)
      opts.chats.forEach((c, i) => (params[`c${i}`] = c))
    }
    if (opts.since !== undefined) {
      where.push('ts >= @since')
      params.since = opts.since
    }
    params.limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT @limit`
    return this.db.prepare(sql).all(params).map(rowToMessage)
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
  }

  /** Atomically claim an idempotency key. Returns the existing row if the key was already used. */
  claimIdempotency(row: Omit<IdempotencyRow, 'status' | 'message_id' | 'error' | 'created_at'>): { claimed: true } | { claimed: false; existing: IdempotencyRow } {
    const r = this.db
      .prepare(`INSERT INTO idempotency (key, approval_id, to_jid, payload_hash, status) VALUES (@key, @approval_id, @to_jid, @payload_hash, 'pending') ON CONFLICT(key) DO NOTHING`)
      .run(row)
    if (r.changes > 0) return { claimed: true }
    return { claimed: false, existing: this.db.prepare('SELECT * FROM idempotency WHERE key = ?').get(row.key) as IdempotencyRow }
  }

  completeIdempotency(key: string, status: 'sent' | 'failed', messageId: string | null, error: string | null = null): void {
    this.db.prepare('UPDATE idempotency SET status = ?, message_id = ?, error = ? WHERE key = ?').run(status, messageId, error, key)
  }

  close(): void {
    this.db.close()
  }
}

function rowToMessage(r: unknown): StoredMessage {
  const row = r as Record<string, unknown>
  return {
    id: String(row.id),
    chat_id: String(row.chat_id),
    from: String(row.from_jid),
    from_name: (row.from_name as string | null) ?? null,
    ts: Number(row.ts),
    text: (row.text as string | null) ?? null,
    direction: row.direction === 'out' ? 'out' : 'in',
    media_mime: (row.media_mime as string | null) ?? null,
    media_filename: (row.media_filename as string | null) ?? null,
    media_path: (row.media_path as string | null) ?? null,
    media_size: row.media_size == null ? null : Number(row.media_size),
    forwarded: Number(row.forwarded) === 1,
    is_forwarded: Number(row.is_forwarded) === 1,
    quoted_id: (row.quoted_id as string | null) ?? null,
    media_sha256: (row.media_sha256 as string | null) ?? null,
    deleted: Number(row.deleted) === 1,
    edited_at: row.edited_at == null ? null : Number(row.edited_at),
  }
}

function rowToLifecycle(r: unknown): LifecycleEvent {
  const row = r as Record<string, unknown>
  return {
    seq: Number(row.seq),
    kind: row.kind === 'delete' ? 'delete' : 'edit',
    msg_id: String(row.msg_id),
    chat_id: String(row.chat_id),
    from: String(row.from_jid),
    ts: Number(row.ts),
    text: (row.text as string | null) ?? null,
    forwarded: Number(row.forwarded) === 1,
  }
}

/** Parse `since` as unix seconds, unix ms, or ISO-8601. */
export function parseSince(v: string | undefined): number | undefined {
  if (!v) return undefined
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    return n > 1e12 ? Math.floor(n / 1000) : n
  }
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000)
}

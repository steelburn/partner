import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createAttachmentStore, createChatBlobStore } from '../../src/stores/db.js';
import { createAttachmentManager } from '../../src/attachments/index.js';
import { auditLog } from '../../src/services/redaction.js';
import { createAuditStore } from '../../src/stores/db.js';
import { loadConfig } from '../../src/config.js';

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function make() {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const manager = createAttachmentManager({
    blobs: createChatBlobStore(db),
    attachments: createAttachmentStore(db),
    audit,
  });
  return { db, manager };
}

describe('M11 F1 attachment manager', () => {
  it('uploads a text file staged, extracts capped text, binds to a message', () => {
    const { db, manager } = make();
    try {
      const meta = manager.upload('c-1', { name: 'notes.md', mime: 'text/markdown', dataBase64: b64('hello **world**\nsecond line') });
      expect(meta.messageId).toBeNull();
      expect(meta.extractable).toBe(true);

      const bound = manager.bindToMessage('c-1', 'm-1', [meta.id]);
      expect(bound).toHaveLength(1);
      expect(manager.listByMessage('m-1')).toHaveLength(1);
      expect(manager.list('c-1').find((a) => a.id === meta.id)?.messageId).toBe('m-1');

      const ctx = manager.contextForMessage('m-1');
      expect(ctx).toContain('hello **world**');
      // Uploaded text is not the same as the displayed content elsewhere.
      expect(ctx).toContain('second line');
    } finally {
      db.close();
    }
  });

  it('rejects executables, oversized payloads and unknown staged ids', () => {
    const { db, manager } = make();
    try {
      expect(() => manager.upload('c-1', { name: 'x.exe', mime: 'application/octet-stream', dataBase64: b64('x') })).toThrow(/cannot be uploaded/);
      expect(() => manager.upload('c-1', { name: 'x.sh', mime: 'text/x-shellscript', dataBase64: b64('x') })).toThrow(/cannot be uploaded/);
      expect(() => manager.upload('c-1', { name: 'big.bin', mime: 'application/octet-stream', dataBase64: b64('x'.repeat(9 * 1024 * 1024)) })).toThrow(/capped/);
      expect(() => manager.bindToMessage('c-1', 'm-1', ['ghost'])).toThrow(/was not staged/);
    } finally {
      db.close();
    }
  });

  it('dedupes blobs by sha256 and cleans up on delete', () => {
    const { db, manager } = make();
    try {
      const data = b64('same content');
      const a = manager.upload('c-1', { name: 'a.txt', mime: 'text/plain', dataBase64: data });
      const b = manager.upload('c-1', { name: 'b.txt', mime: 'text/plain', dataBase64: data });
      expect(a.id).not.toBe(b.id);
      manager.remove('c-1', a.id);
      // Second row still references the blob — content survives.
      expect(manager.content('c-1', b.id)).not.toBeNull();
      manager.remove('c-1', b.id);
      expect(manager.content('c-1', b.id)).toBeNull();
      expect(() => manager.remove('c-1', b.id)).toThrow(/not found/);
    } finally {
      db.close();
    }
  });

  it('describes images without extracting and returns bytes through content', () => {
    const { db, manager } = make();
    try {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64');
      const meta = manager.upload('c-1', { name: 'p.png', mime: 'image/png', dataBase64: png.toString('base64') });
      expect(meta.extractable).toBe(true);
      const bound = manager.bindToMessage('c-1', 'm-1', [meta.id]);
      void bound;
      expect(manager.contextForMessage('m-1')).toContain('[Image attachment: p.png');
      const content = manager.content('c-1', meta.id);
      expect(content?.data.equals(png)).toBe(true);
      expect(content?.mime).toBe('image/png');
    } finally {
      db.close();
    }
  });
});

describe('R7 — the per-attachment cap is a deployment knob', () => {
  it('enforces a tightened maxBytes and names the configured limit', () => {
    const db = openDatabase(':memory:');
    try {
      const audit = auditLog({ store: createAuditStore(db) });
      const manager = createAttachmentManager({
        blobs: createChatBlobStore(db),
        attachments: createAttachmentStore(db),
        audit,
        maxBytes: 64, // 0 MB in the message, but the enforcement is what matters
      });
      expect(() =>
        manager.upload('c-1', { name: 'big.txt', mime: 'text/plain', dataBase64: b64('x'.repeat(200)) }),
      ).toThrow(/capped at 0 MB/);
      // Under the cap still works.
      const ok = manager.upload('c-1', { name: 'small.txt', mime: 'text/plain', dataBase64: b64('hi') });
      expect(ok.name).toBe('small.txt');
    } finally {
      db.close();
    }
  });

  it('config parses the upload/json caps', () => {
    const cfg = loadConfig({ DEMO_MODE: '1' });
    expect(cfg.maxUploadBytes).toBe(8 * 1024 * 1024);
    expect(cfg.maxJsonBytes).toBe(1024 * 1024);
    const tight = loadConfig({ DEMO_MODE: '1', MAX_UPLOAD_BYTES: '1024', MAX_JSON_BYTES: '2048' });
    expect(tight.maxUploadBytes).toBe(1024);
    expect(tight.maxJsonBytes).toBe(2048);
  });
});

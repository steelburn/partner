import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createAttachmentStore, createChatBlobStore } from '../../src/stores/db.js';
import { createAttachmentManager } from '../../src/attachments/index.js';
import { auditLog } from '../../src/services/redaction.js';
import { createAuditStore } from '../../src/stores/db.js';
import { loadConfig } from '../../src/config.js';

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
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
      const meta = manager.upload('c-1', { name: 'notes.md', mime: 'text/markdown', data: bytes('hello **world**\nsecond line') });
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
      expect(() => manager.upload('c-1', { name: 'x.exe', mime: 'application/octet-stream', data: bytes('x') })).toThrow(/cannot be uploaded/);
      expect(() => manager.upload('c-1', { name: 'x.sh', mime: 'text/x-shellscript', data: bytes('x') })).toThrow(/cannot be uploaded/);
      // The cap message names the file, its size and the limit (M22/R7): it is
      // the same sentence the SPA shows before uploading.
      expect(() =>
        manager.upload('c-1', { name: 'big.bin', mime: 'application/octet-stream', data: bytes('x'.repeat(9 * 1024 * 1024)) }),
      ).toThrow(/^big\.bin is 9 MB — the limit is 8 MB per file\.$/);
      expect(() => manager.bindToMessage('c-1', 'm-1', ['ghost'])).toThrow(/was not staged/);
    } finally {
      db.close();
    }
  });

  it('dedupes blobs by sha256 and cleans up on delete', () => {
    const { db, manager } = make();
    try {
      const data = bytes('same content');
      const a = manager.upload('c-1', { name: 'a.txt', mime: 'text/plain', data });
      const b = manager.upload('c-1', { name: 'b.txt', mime: 'text/plain', data });
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
      const meta = manager.upload('c-1', { name: 'p.png', mime: 'image/png', data: png });
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

  it('M24: an image over the inline budget says so, instead of reading as sent', () => {
    const { db, manager } = make();
    try {
      // Under the 8 MB upload cap, over the 3 MB inline budget: it stores, it
      // previews, and the turn cannot send it. The descriptor is the only thing
      // the model sees, so it must not read like a successful attachment.
      const big = Buffer.alloc(4 * 1024 * 1024, 7);
      const meta = manager.upload('c-1', { name: 'scan.png', mime: 'image/png', data: big });
      manager.bindToMessage('c-1', 'm-1', [meta.id]);
      const ctx = manager.contextForMessage('m-1');
      expect(ctx).toContain('[Image attachment: scan.png');
      expect(ctx).toContain('NOT sent');
      expect(ctx).toContain(String(big.length));

      // And an image that DOES fit is described plainly, with no false alarm.
      const small = manager.upload('c-1', { name: 'ok.png', mime: 'image/png', data: bytes('x') });
      manager.bindToMessage('c-1', 'm-2', [small.id]);
      const ok = manager.contextForMessage('m-2');
      expect(ok).toContain('[Image attachment: ok.png');
      expect(ok).not.toContain('NOT sent');
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
        maxBytes: 64,
      });
      // A sub-KB cap is quoted in bytes, never rounded down to "0 MB".
      expect(() =>
        manager.upload('c-1', { name: 'big.txt', mime: 'text/plain', data: bytes('x'.repeat(200)) }),
      ).toThrow(/^big\.txt is 200 bytes — the limit is 64 bytes per file\.$/);
      // Under the cap still works.
      const ok = manager.upload('c-1', { name: 'small.txt', mime: 'text/plain', data: bytes('hi') });
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

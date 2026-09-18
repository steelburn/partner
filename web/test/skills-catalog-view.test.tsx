/**
 * M32 — the Skills Catalog as a Personas-style card deck.
 *
 * The request: "turn Skills\\Catalog similar to Personas." The Catalog now
 * renders as a card grid whose card face opens a slide-out detail drawer,
 * reusing the Persona deck/drawer classes so the two pages cannot drift.
 *
 * The suite is node-only, so the drawer is rendered with
 * `renderToStaticMarkup` (its markup is the evidence) and the deck wiring is
 * asserted against the source, where it genuinely is a source property.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CatalogSkill } from '@partner/shared';
import { CatalogDrawer } from '../src/SkillsView.js';
import { source } from './helpers/css.js';

const VIEW = source('src/SkillsView.tsx');

const SKILL: CatalogSkill = {
  id: 'content-audit',
  name: 'Content audit',
  description: 'Audits your content for broken links and stale claims.',
  author: 'Partner',
  version: '1.2.0',
  permissions: { tools: ['files.list'], network: false, risk: 'low' },
};

const noop = (): void => undefined;

function render(overrides: Partial<Parameters<typeof CatalogDrawer>[0]> = {}): string {
  return renderToStaticMarkup(
    h(CatalogDrawer, {
      skill: SKILL,
      installed: false,
      installing: false,
      disabled: false,
      onInstall: noop,
      onManage: noop,
      onClose: noop,
      ...overrides,
    }),
  );
}

describe('the Catalog is a card deck with a slide-out drawer', () => {
  it('reuses the Persona deck/drawer classes, not a parallel set', () => {
    expect(VIEW).toContain('className="persona-deck catalog-deck"');
    expect(VIEW).toContain('className="persona-card catalog-card"');
    expect(VIEW).toContain('className="persona-drawer catalog-drawer"');
    // The card face opens the detail drawer; the footer keeps Install/Manage.
    expect(VIEW).toContain('onClick={() => setDrawer(skill)}');
    expect(VIEW).toContain("className=\"persona-card-edit-hint\"");
  });

  it('the drawer is a modal dialog with a scrim and an Escape close', () => {
    expect(VIEW).toContain('className="persona-drawer-scrim"');
    expect(VIEW).toContain('role="dialog"');
    expect(VIEW).toContain('aria-modal="true"');
    expect(VIEW).toMatch(/event\.key === 'Escape'[\s\S]{0,40}setDrawer\(null\)/);
  });
});

describe('CatalogDrawer markup', () => {
  it('names the skill and shows its declared permissions', () => {
    const html = render();
    expect(html).toContain('Content audit');
    expect(html).toContain('Partner@1.2.0');
    expect(html).toContain('Permissions');
    // The permission chip carries the declared tool and the risk ceiling.
    expect(html).toContain('files.list');
    expect(html).toContain('Low risk');
  });

  it('offers Install when not installed and Manage when installed', () => {
    const fresh = render();
    expect(fresh).toContain('>Install<');
    expect(fresh).not.toContain('Manage installed');

    const installed = render({ installed: true });
    expect(installed).toContain('Manage installed');
    expect(installed).toContain('Installed');
  });

  it('the installing state names the wait and disables the action', () => {
    const html = render({ installing: true, disabled: true });
    expect(html).toContain('Installing…');
    expect(html).toMatch(/disabled/);
  });
});

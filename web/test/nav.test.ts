/**
 * Nav model coverage (M20.A).
 *
 * The regression this guards: a phone shows only `MOBILE_TABS` plus the More
 * sheet, so a view added to the sidebar but not to the mobile lists becomes
 * *unreachable on a phone* while every type-check and every other test stays
 * green. These assertions are cheap and catch exactly that.
 */
import { describe, expect, it } from 'vitest';
import {
  MOBILE_MORE,
  MOBILE_TABS,
  NAV_GROUPS,
  NAV_LABELS,
  VIEW_NAMES,
  mobileReachableViews,
  sidebarViews,
} from '../src/lib/nav.js';

describe('nav model', () => {
  it('sidebar groups cover every view exactly once, in VIEW_NAMES order', () => {
    const listed = sidebarViews();
    expect([...listed].sort()).toEqual([...VIEW_NAMES].sort());
    expect(new Set(listed).size).toBe(listed.length);
    // Desktop order is meaningful (M14 group order); assert it is preserved.
    expect(listed).toEqual([...VIEW_NAMES]);
  });

  it('phone tabs plus the More sheet cover every view exactly once', () => {
    const mobile = mobileReachableViews();
    expect([...mobile].sort()).toEqual([...VIEW_NAMES].sort());
    expect(new Set(mobile).size).toBe(mobile.length);
  });

  it('keeps the phone tabs to a tappable count and leads with chat', () => {
    // Five slots is the ceiling that stays >= 44px wide at 360px (72px each).
    expect(MOBILE_TABS.length).toBeLessThanOrEqual(5);
    expect(MOBILE_TABS[0]).toBe('chat');
    // The approval queue must not be buried in the More sheet.
    expect(MOBILE_TABS).toContain('files');
  });

  it('does not duplicate a view between tabs and the More sheet', () => {
    const overlap = MOBILE_TABS.filter((view) => MOBILE_MORE.includes(view));
    expect(overlap).toEqual([]);
  });

  it('has a non-empty label for every view', () => {
    for (const view of VIEW_NAMES) {
      expect(NAV_LABELS[view]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('names every group', () => {
    for (const group of NAV_GROUPS) {
      expect(group.name.length).toBeGreaterThan(0);
      expect(group.views.length).toBeGreaterThan(0);
    }
  });
});

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Persona } from '@partner/shared';
import { levelLabel, personaInitials } from './lib/persona-helpers.js';

export interface PersonaPickerProps {
  personas: Persona[];
  /** Id of the persona new chats will use. */
  activePersonaId: string | null;
  /** Disabled while a turn is streaming (active persona must not change mid-turn). */
  disabled: boolean;
  onSelect: (id: string) => void;
}

/**
 * Header persona selector. The trigger summarizes the active persona (name +
 * paused/level chips) and opens a popover listing every persona with its
 * initials avatar, level chip, paused badge and default tag. The popover
 * closes on outside click (scrim), Escape, or an option press.
 */
export default function PersonaPicker({
  personas,
  activePersonaId,
  disabled,
  onSelect,
}: PersonaPickerProps) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const active = personas.find((p) => p.id === activePersonaId) ?? null;

  useEffect(() => {
    if (!open) return;
    const first = listRef.current?.querySelector<HTMLButtonElement>('button');
    first?.focus();
  }, [open]);

  const close = (): void => setOpen(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="picker">
      <button
        type="button"
        className="btn btn-secondary picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Active persona"
      >
        <span className="picker-avatar" aria-hidden="true">
          {active ? personaInitials(active.name) : '?'}
        </span>
        <span className="picker-label">
          {active ? active.name : personas.length === 0 ? 'No persona' : 'Pick a persona'}
        </span>
        {active?.paused ? <span className="chip">Paused</span> : null}
        {active ? (
          /* `picker-level` exists so the phone tier can drop this chip alone:
           * the phone top bar also carries the assets toggle and the
           * per-conversation theme select, and the level is the one chip that
           * is repeated in the sheet this button opens. Paused must stay — a
           * paused persona refuses chat — so the two chips are not one class. */
          <span className="chip picker-level">{levelLabel(active.independence.level)}</span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            className="picker-scrim"
            tabIndex={-1}
            aria-label="Close persona list"
            onClick={close}
          />
          <div
            ref={listRef}
            className="picker-pop"
            role="listbox"
            aria-label="Personas"
            aria-busy={false}
            onKeyDown={handleKeyDown}
          >
            {personas.map((persona) => {
              const isActive = persona.id === activePersonaId;
              return (
                <button
                  type="button"
                  key={persona.id}
                  role="option"
                  aria-selected={isActive}
                  className="picker-option"
                  onClick={() => {
                    onSelect(persona.id);
                    close();
                  }}
                >
                  <span className="persona-avatar picker-option-avatar" aria-hidden="true">
                    {personaInitials(persona.name)}
                  </span>
                  <span className="picker-option-text">
                    <span className="picker-option-name">
                      {persona.name}
                      {persona.isDefault ? <span className="picker-option-default">Default</span> : null}
                    </span>
                    {persona.tagline ? (
                      <span className="picker-option-tagline">{persona.tagline}</span>
                    ) : null}
                  </span>
                  <span className="picker-option-meta">
                    {persona.paused ? <span className="chip">Paused</span> : null}
                    <span className="chip">{levelLabel(persona.independence.level)}</span>
                  </span>
                  {isActive ? <span className="picker-option-active">Active</span> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
